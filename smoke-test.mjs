#!/usr/bin/env node
// Smoke test: spawn the built stdio server via the official MCP SDK Client +
// StdioClientTransport, initialize, list tools (assert all 5 with valid schemas),
// and, when X402_LIST_SMOKE_LIVE is set, call get_facilitator_volumes and
// search_x402_services against the live API asserting non-empty, correctly
// shaped results with USD values passed through UNSCALED (verified by comparing
// the tool output to a direct fetch of the same endpoint).
//
// Assumes `npm run build` already produced dist/. Run: node smoke-test.mjs
// Exits non-zero on any assertion failure.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, "dist", "index.js");
const BASE = (process.env.X402_LIST_BASE_URL ?? "https://x402-list.com").replace(/\/+$/, "");
const LIVE = !!process.env.X402_LIST_SMOKE_LIVE && process.env.X402_LIST_SMOKE_LIVE !== "0";

const EXPECTED_TOOLS = [
  "search_x402_services",
  "get_service",
  "find_best_service",
  "check_health",
  "get_facilitator_volumes",
];

const log = (...a) => console.error(...a);
function assert(cond, msg) {
  if (!cond) throw new Error("ASSERTION FAILED: " + msg);
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    cwd: __dirname,
    stderr: "inherit",
  });
  const client = new Client({ name: "x402-list-mcp-smoke", version: "0.0.0" }, { capabilities: {} });

  await client.connect(transport); // performs initialize handshake
  log("connected (initialize ok)");

  // ---- tools/list ----
  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  log("tools:", names.join(", "));
  for (const want of EXPECTED_TOOLS) {
    assert(names.includes(want), `tool '${want}' present`);
  }
  assert(listed.tools.length === EXPECTED_TOOLS.length, `exactly ${EXPECTED_TOOLS.length} tools`);
  for (const t of listed.tools) {
    assert(t.description && t.description.length > 10, `tool '${t.name}' has a description`);
    assert(
      t.inputSchema && t.inputSchema.type === "object" && typeof t.inputSchema.properties === "object",
      `tool '${t.name}' has a valid object inputSchema`,
    );
  }
  log("PASS: all 5 tools present with valid object input schemas");

  const samples = {};

  if (LIVE) {
    log(`live mode ON, base ${BASE}`);

    // ---- get_facilitator_volumes (live) ----
    const fvRes = await client.callTool({
      name: "get_facilitator_volumes",
      arguments: { timeframe: "7d", per_page: 25 },
    });
    assert(!fvRes.isError, "get_facilitator_volumes did not error");
    const fv = fvRes.structuredContent;
    assert(fv && Array.isArray(fv.facilitators) && fv.facilitators.length > 0, "facilitators non-empty");
    const f0 = fv.facilitators[0];
    assert(typeof f0.facilitator_id === "string", "facilitator has id");
    assert(typeof f0.volume_usd_all === "number", "volume_usd_all is a number");
    assert(typeof f0.volume_usd_7d === "number", "volume_usd_7d is a number");
    assert(f0.verification === "on-chain" || f0.verification === "listed", "verification flag valid");

    // USD pass-through: compare against a direct fetch of the same endpoint.
    const rawFac = await (
      await fetch(`${BASE}/api/v1/facilitators?timeframe=7d&per_page=25&page=1`, {
        headers: { accept: "application/json" },
      })
    ).json();
    const rawF0 = rawFac.data[0];
    assert(
      f0.volume_usd_all === rawF0.volume_usd_all,
      `volume_usd_all passed through unscaled (tool ${f0.volume_usd_all} === api ${rawF0.volume_usd_all})`,
    );
    assert(
      f0.volume_usd_7d === rawF0.volume_usd_7d,
      `volume_usd_7d passed through unscaled (tool ${f0.volume_usd_7d} === api ${rawF0.volume_usd_7d})`,
    );
    log(
      `PASS: get_facilitator_volumes -> ${fv.facilitators.length} facilitators; top ${f0.facilitator_id} volume_usd_all=$${f0.volume_usd_all} (== live API), verification=${f0.verification}`,
    );
    samples.get_facilitator_volumes = {
      count: fv.facilitators.length,
      top: {
        facilitator_id: f0.facilitator_id,
        name: f0.name,
        volume_usd_24h: f0.volume_usd_24h,
        volume_usd_7d: f0.volume_usd_7d,
        volume_usd_30d: f0.volume_usd_30d,
        volume_usd_all: f0.volume_usd_all,
        tx_count_7d: f0.tx_count_7d,
        verification: f0.verification,
      },
      units: fv.units,
    };

    // ---- search_x402_services (live) ----
    const sRes = await client.callTool({
      name: "search_x402_services",
      arguments: { per_page: 5, sort: "newest" },
    });
    assert(!sRes.isError, "search_x402_services did not error");
    const sc = sRes.structuredContent;
    assert(sc && Array.isArray(sc.services) && sc.services.length > 0, "services non-empty");
    assert(sc.meta && typeof sc.meta.total === "number" && sc.meta.total > 0, "meta.total > 0");
    const svc0 = sc.services[0];
    assert(typeof svc0.slug === "string" && svc0.slug.length > 0, "service has slug");
    assert(
      svc0.min_price_usd === null || typeof svc0.min_price_usd === "number",
      "min_price_usd is number|null",
    );

    // USD pass-through for a service price: direct fetch comparison.
    const rawSvc = await (
      await fetch(`${BASE}/api/v1/services?per_page=5&sort=newest&page=1`, {
        headers: { accept: "application/json" },
      })
    ).json();
    const rawSvc0 = rawSvc.data.find((x) => x.slug === svc0.slug);
    assert(rawSvc0, "matched live service by slug");
    assert(
      svc0.min_price_usd === rawSvc0.min_price_usd,
      `min_price_usd passed through unscaled (tool ${svc0.min_price_usd} === api ${rawSvc0.min_price_usd})`,
    );
    log(
      `PASS: search_x402_services -> ${sc.services.length} of ${sc.meta.total}; first '${svc0.slug}' min_price_usd=${svc0.min_price_usd} (== live API)`,
    );
    samples.search_x402_services = {
      returned: sc.services.length,
      total: sc.meta.total,
      first: {
        slug: svc0.slug,
        name: svc0.name,
        category: svc0.category,
        status: svc0.status,
        verified: svc0.verified,
        min_price_usd: svc0.min_price_usd,
        networks: svc0.networks,
      },
    };
  } else {
    log("live mode OFF (set X402_LIST_SMOKE_LIVE=1 to call the live API)");
  }

  await client.close();

  console.error("\n--- SAMPLES ---");
  console.error(JSON.stringify({ tools: names, live: LIVE, samples }, null, 2));
  console.error(`\nSMOKE PASS${LIVE ? " (with live API checks)" : " (offline tool-list only)"}`);
}

main().catch((e) => {
  console.error("\nSMOKE FAIL:", e?.message ?? e);
  process.exit(1);
});
