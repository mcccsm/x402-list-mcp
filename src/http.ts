// Streamable HTTP transport server (hosted mode), built on Node's native http.
// One McpServer instance per MCP session, per the MCP spec. The SDK transport
// does the protocol work (POST messages, GET SSE stream, DELETE terminate); this
// wrapper only handles routing, CORS, the /healthz probe, and the session registry
// (bounded: idle TTL + LRU cap, see sessions.ts).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "./server.js";
import { SessionRegistry } from "./sessions.js";

const MAX_BODY_BYTES = 1024 * 1024; // ~1 MB
const SWEEP_INTERVAL_MS = 60_000;

const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, accept, mcp-session-id, last-event-id, mcp-protocol-version, authorization",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

export async function startHttp(port: number): Promise<void> {
  const transports = new SessionRegistry<StreamableHTTPServerTransport>();
  // unref: the sweeper must never be the reason the process stays up.
  setInterval(() => transports.sweep(), SWEEP_INTERVAL_MS).unref();

  const httpServer = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      console.error("HTTP handler error:", e);
      if (!res.headersSent) jsonRpcError(res, 500, "Internal server error");
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    applyCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Health probe (NOT an MCP route): handled before MCP routing.
    if (path === "/healthz") {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      sendJson(res, 200, { status: "ok" });
      return;
    }

    if (path !== "/mcp" && path !== "/") {
      jsonRpcError(res, 404, "Not found");
      return;
    }

    const sid = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readBody(req);
      } catch (e) {
        jsonRpcError(res, 400, `Invalid request body: ${(e as Error).message}`);
        return;
      }

      // get() also refreshes the session's idle clock.
      let transport = sid ? transports.get(sid) : undefined;
      if (!transport) {
        if (sid || !isInitializeRequest(body)) {
          jsonRpcError(res, 400, "No valid session. Send an initialize request first.");
          return;
        }
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            transports.set(id, created);
          },
          ...(ALLOWED_HOSTS.length > 0
            ? { enableDnsRebindingProtection: true, allowedHosts: ALLOWED_HOSTS }
            : {}),
        });
        created.onclose = () => {
          if (created.sessionId) transports.delete(created.sessionId);
        };
        await buildServer().connect(created);
        transport = created;
      }

      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const transport = sid ? transports.get(sid) : undefined;
      if (!transport) {
        jsonRpcError(res, 400, "No valid session.");
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405);
    res.end();
  }

  httpServer.listen(port, () => {
    console.error(`x402-list-mcp HTTP on :${port}/mcp`);
  });
}
