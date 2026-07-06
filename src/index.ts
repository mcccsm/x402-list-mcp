#!/usr/bin/env node
// Entry + bin. Picks transport: stdio by default, Streamable HTTP when --http
// is passed or MCP_HTTP_PORT is set (e.g. in the Docker image).

import { startStdio } from "./server.js";
import { startHttp } from "./http.js";

const args = process.argv.slice(2);
const wantHttp = args.includes("--http") || !!process.env.MCP_HTTP_PORT;
const port = Number(process.env.MCP_HTTP_PORT ?? process.env.PORT ?? 3000);

if (args.includes("--help") || args.includes("-h")) {
  // stdout is safe here: we are not in an active stdio MCP session.
  console.log(
    [
      "x402-list-mcp: read-only MCP server for the x402-list directory.",
      "",
      "Usage:",
      "  x402-list-mcp            Run on stdio (default; for local MCP clients).",
      "  x402-list-mcp --http     Run the Streamable HTTP transport.",
      "",
      "Environment:",
      "  X402_LIST_BASE_URL       API base (default https://x402-list.com).",
      "  X402_LIST_TIMEOUT_MS     Per-request timeout in ms (default 15000).",
      "  MCP_HTTP_PORT / PORT     HTTP port (default 3000). Setting MCP_HTTP_PORT selects HTTP.",
      "  MCP_ALLOWED_ORIGINS      Comma list of allowed CORS origins (HTTP mode).",
      "  MCP_ALLOWED_HOSTS        Comma list enabling DNS-rebinding protection (HTTP mode).",
    ].join("\n"),
  );
  process.exit(0);
}

if (wantHttp) {
  startHttp(port).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  // stdio mode: NOTHING may be written to stdout except the MCP protocol stream.
  startStdio().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
