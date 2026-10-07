import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./server.js";

test("MCP instructions and tool descriptions omit fixed catalog counts without fetching at startup", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("MCP initialization must not fetch a catalog count");
  });
  const server = buildServer();
  const client = new Client({ name: "catalog-copy-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const instructions = client.getInstructions();
  assert.ok(instructions, "initialize must return server instructions");
  const { tools } = await client.listTools();
  // Match catalog sizes, while allowing prices, uptime windows and page limits.
  const fixedCount = /\b\d[\d,.]*\+?\s+(?:listed\b|(?:(?:live[- ]monitored|x402|payment)\s+)*(?:services|APIs)\b)/i;
  for (const [name, copy] of [
    ["instructions", instructions],
    ...tools.map((tool) => [tool.name, tool.description ?? ""]),
  ]) {
    assert.doesNotMatch(copy, fixedCount, `${name} must not hardcode the catalog size`);
  }
  assert.equal(fetch.mock.callCount(), 0, "initialization and tool listing must stay offline");
});
