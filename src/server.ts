// Builds a configured McpServer with all 7 tools registered, plus the stdio
// start helper. The HTTP start helper lives in http.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

// version: keep in sync with package.json and server.json (and the user-agent in api.ts).
export const SERVER_INFO = { name: "x402-list-mcp", version: "0.5.1" };

export function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "x402-list is the directory of services that accept x402 payments: more than 500 listed and live-monitored, plus on-chain-verified settlement volume per facilitator. Reach for it when an agent must choose a paid API, confirm one is still safe to call, or price a call, before writing payment code. Discover with x402_search_services, inspect one with x402_get_service, pick for a stated need with x402_find_best_service, confirm it is up with x402_check_health, see which facilitator actually settles volume with x402_facilitator_volumes, and catch a moved payout address or a reprice with x402_change_events. When the free ranking cannot decide, x402_assess_services buys a fresh AI comparison of a shortlist for $0.25 USDC on Base, signed by your own wallet: this server holds no keys. On-chain figures are a conservative undercount and money fields are decimal US dollars.",
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
