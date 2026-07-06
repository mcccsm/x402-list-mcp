// Builds a configured McpServer with all 5 tools registered, plus the stdio
// start helper. The HTTP start helper lives in http.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

// version: keep in sync with package.json and server.json (and the user-agent in api.ts).
export const SERVER_INFO = { name: "x402-list-mcp", version: "0.1.1" };

export function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "x402-list is the directory of services that accept x402 payments, with on-chain-verified settlement volume per facilitator. Use search_x402_services to discover, get_service for detail, find_best_service to recommend (reliability/price, NOT volume), check_health for status, get_facilitator_volumes for the per-facilitator on-chain settlement metric. All money fields are decimal US dollars.",
  });
  registerTools(server);
  return server;
}

export async function startStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio hygiene: diagnostics go to stderr only; stdout is the JSON-RPC channel.
  console.error("x402-list-mcp running on stdio");
}
