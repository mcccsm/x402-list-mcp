// Builds a configured McpServer with all 5 tools registered, plus the stdio
// start helper. The HTTP start helper lives in http.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

// version: keep in sync with package.json and server.json (and the user-agent in api.ts).
export const SERVER_INFO = { name: "x402-list-mcp", version: "0.3.0" };

export function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "x402-list is the directory of services that accept x402 payments, with on-chain-verified settlement volume per facilitator. Use search_x402_services to discover, get_service for detail, find_best_service to recommend (ranked mostly on reliability, x402 compliance and price, with a SMALL ~10% weight on measured per-service on-chain traction; a service whose payTo is shared across services has its traction attributed pro-quota - volume and buyers divided by the services sharing the payout - while an unmeasured network or a suppressed member carries no traction term), check_health for status, get_facilitator_volumes for the per-facilitator on-chain settlement metric. On-chain figures are a conservative undercount and all money fields are decimal US dollars.",
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
