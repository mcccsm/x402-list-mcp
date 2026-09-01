// T5-C hardening tests for the 7 MCP tools (findings B-14#1, B-16#0, B-14#4, A-17#3, A-17#4, A-17#5).
// Two harnesses: (1) capture the registered tool DEFINITIONS so we can parse args against the strict
// inputSchema exactly as the SDK does (normalizeObjectSchema on a ZodObject returns it as-is, then
// safeParseAsync === .safeParse), proving unknown top-level keys are now REJECTED, not dropped; and
// (2) the same fetch-mock + handler-capture pattern as tools.test.ts to exercise response shaping.
// Run with: npx tsx --test mcp/src/tools.hardening.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// ── harness A: capture tool defs (for schema parsing) and handlers ──────────────────
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: "text"; text: string }[];
}>;
type ParsableSchema = { safeParse(v: unknown): { success: boolean } };
type ToolDef = { inputSchema?: ParsableSchema };

const DEFS: Record<string, ToolDef> = {};
const HANDLERS: Record<string, ToolHandler> = {};
{
  const fakeServer = {
    registerTool(name: string, def: ToolDef, handler: ToolHandler) {
      DEFS[name] = def;
      HANDLERS[name] = handler;
    },
  } as unknown as McpServer;
  registerTools(fakeServer);
}

// ── harness B: mock global.fetch with a URL-routed responder + call recorder ─────────
interface FetchCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}
let CALLS: FetchCall[] = [];
const realFetch = global.fetch;
function makeRes(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    text: async () => text,
  } as unknown as Response;
}
function installFetch(router: (url: URL) => Response): void {
  CALLS = [];
  global.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const raw = typeof input === "string" ? input : String(input);
    const url = new URL(raw);
    CALLS.push({
      url,
      method: (init.method ?? "GET").toUpperCase(),
      headers: (init.headers as Record<string, string>) ?? {},
      body: typeof init.body === "string" ? init.body : null,
    });
    return router(url);
  }) as unknown as typeof fetch;
}
function restoreFetch(): void {
  global.fetch = realFetch;
}

// ══ B-14#1 + B-16#0: strict inputSchema rejects unknown top-level keys ═══════════════
// Minimal VALID args per tool (defaults fill the rest), and the same args + one bogus key.
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  x402_search_services: {},
  x402_get_service: { slug: "my-api" },
  x402_find_best_service: {},
  x402_check_health: {},
  x402_facilitator_volumes: {},
  x402_assess_services: { question: "which is cheapest?", services: ["a-svc"] },
  x402_change_events: {},
};

for (const [name, valid] of Object.entries(VALID_ARGS)) {
  test(`B-14#1: ${name} inputSchema accepts valid args and REJECTS an unknown key`, () => {
    const schema = DEFS[name].inputSchema!;
    assert.equal(schema.safeParse(valid).success, true, `${name} should accept its valid args`);
    assert.equal(
      schema.safeParse({ ...valid, definitely_not_a_real_key: 1 }).success,
      false,
      `${name} must reject an unknown top-level key (advertised additionalProperties:false)`,
    );
  });
}

test("B-16#0: x402_find_best_service rejects the near-miss key 'query' (was silently dropped -> need-blind)", () => {
  const schema = DEFS.x402_find_best_service.inputSchema!;
  // The bug: 'query' (instead of 'q') was accepted, dropped, and answered as a need-blind ranking.
  assert.equal(schema.safeParse({ query: "web scraping" }).success, false);
  assert.equal(schema.safeParse({ q: "web scraping" }).success, true);
});

test("B-14#1: x402_search_services rejects the plural 'networks' near-miss for 'network'", () => {
  const schema = DEFS.x402_search_services.inputSchema!;
  assert.equal(schema.safeParse({ networks: "ethereum" }).success, false);
  assert.equal(schema.safeParse({ network: "ethereum" }).success, true);
});

// ══ B-16#0: need_blind_ranking flag on the response ══════════════════════════════════
function bestBody(over: Record<string, unknown> = {}) {
  return {
    data: {
      recommendations: [],
      ranking_basis: "Two stages...",
      excluded_danger: [],
      facilitator_context: null,
      ...over,
    },
    meta: { ranking_version: 3 },
  };
}

test("B-16#0: x402_find_best_service flags need_blind_ranking=true when no q is given", async () => {
  installFetch((url) => (url.pathname.endsWith("/best") ? makeRes(200, bestBody()) : makeRes(404, {})));
  try {
    const res = await HANDLERS.x402_find_best_service({ category: "AI" });
    assert.equal(res.structuredContent!.need_blind_ranking, true);
  } finally {
    restoreFetch();
  }
});

test("B-16#0: x402_find_best_service flags need_blind_ranking=false when q is present", async () => {
  installFetch((url) => (url.pathname.endsWith("/best") ? makeRes(200, bestBody()) : makeRes(404, {})));
  try {
    const res = await HANDLERS.x402_find_best_service({ q: "web scraping" });
    assert.equal(res.structuredContent!.need_blind_ranking, false);
  } finally {
    restoreFetch();
  }
});

// ══ B-14#4: compact (default) drops the heavy assessment block; full restores it ══════
function fullServiceItem() {
  return {
    slug: "weather-x402",
    name: "Weather x402",
    description: "A".repeat(400), // heavy free text, dropped in compact
    base_url: "https://weather.example",
    website_url: "https://weather.example/site",
    category: "Data",
    status: "online",
    verified: true,
    endpoint_count: 3,
    min_price_usd: 0.01,
    networks: ["BSE"],
    networks_caip2: ["eip155:8453"],
    uptime_24h: 99.5,
    avg_response_time_ms: 120,
    last_checked_at: "2026-08-05T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
    assessment: { compliance_grade: "A", risk_level: "clean", reliability_uptime_30d: 99, traction: null },
  };
}
function servicesBodyWith(items: unknown[]) {
  return { data: items, meta: { page: 1, per_page: 25, total: items.length, total_pages: 1 } };
}

test("B-14#4: search default (compact) omits assessment + description, keeps compliance_grade", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/services") ? makeRes(200, servicesBodyWith([fullServiceItem()])) : makeRes(404, {}),
  );
  try {
    const res = await HANDLERS.x402_search_services({ status: "all", sort: "newest", verified_only: false, page: 1, per_page: 25 });
    assert.equal(res.structuredContent!.fields, "compact");
    const svcs = res.structuredContent!.services as Record<string, unknown>[];
    assert.equal(svcs.length, 1);
    assert.equal("assessment" in svcs[0], false, "compact must drop the assessment block");
    assert.equal("description" in svcs[0], false, "compact must drop the long description");
    assert.equal(svcs[0].compliance_grade, "A", "compact keeps the compliance grade scalar");
    assert.equal(svcs[0].min_price_usd, 0.01);
  } finally {
    restoreFetch();
  }
});

test("B-14#4: search fields='full' returns the full item verbatim (assessment present)", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/services") ? makeRes(200, servicesBodyWith([fullServiceItem()])) : makeRes(404, {}),
  );
  try {
    const res = await HANDLERS.x402_search_services({ status: "all", sort: "newest", verified_only: false, page: 1, per_page: 25, fields: "full" });
    assert.equal(res.structuredContent!.fields, "full");
    const svcs = res.structuredContent!.services as Record<string, unknown>[];
    assert.deepEqual(svcs[0], fullServiceItem());
  } finally {
    restoreFetch();
  }
});

test("B-14#4: page and per_page carry a description on the live schema", () => {
  // Guard against the 'no description at all' regression the finding calls out. We read the JSON
  // schema the SDK would advertise by round-tripping through the same zod object.
  const schema = DEFS.x402_search_services.inputSchema as unknown as {
    shape: Record<string, { description?: string }>;
  };
  assert.equal(typeof schema.shape.page.description, "string");
  assert.equal(typeof schema.shape.per_page.description, "string");
  assert.equal(typeof schema.shape.fields.description, "string");
});

// ══ A-17#3: x402_check_health directory returns counts only by default; services on request ═══
function statusBody(services: unknown[]) {
  return {
    data: {
      total: services.length,
      online: services.length,
      degraded: 0,
      offline: 0,
      unknown: 0,
      services,
    },
  };
}
const STATUS_SVCS = [
  { slug: "a", name: "A", status: "online", last_checked_at: null, consecutive_failures: 0, uptime_24h: 100, avg_response_time_ms: 50 },
  { slug: "b", name: "B", status: "online", last_checked_at: null, consecutive_failures: 0, uptime_24h: 99, avg_response_time_ms: 60 },
];

test("A-17#3: x402_check_health directory default omits the per-service list, keeps the summary", async () => {
  installFetch((url) => (url.pathname.endsWith("/status") ? makeRes(200, statusBody(STATUS_SVCS)) : makeRes(404, {})));
  try {
    const res = await HANDLERS.x402_check_health({ uptime_period: "30d" });
    const out = res.structuredContent!;
    assert.equal(out.mode, "directory");
    assert.deepEqual(out.summary, { total: 2, online: 2, degraded: 0, offline: 0, unknown: 0 });
    assert.equal("services" in out, false, "directory default must NOT include the full service list");
  } finally {
    restoreFetch();
  }
});

test("A-17#3: x402_check_health directory include_services=true attaches the list", async () => {
  installFetch((url) => (url.pathname.endsWith("/status") ? makeRes(200, statusBody(STATUS_SVCS)) : makeRes(404, {})));
  try {
    const res = await HANDLERS.x402_check_health({ uptime_period: "30d", include_services: true });
    const out = res.structuredContent!;
    assert.deepEqual(out.services, STATUS_SVCS);
  } finally {
    restoreFetch();
  }
});

test("A-17#3: ok() text mirror is compact (single-line), not a second pretty-printed copy", async () => {
  installFetch((url) => (url.pathname.endsWith("/status") ? makeRes(200, statusBody(STATUS_SVCS)) : makeRes(404, {})));
  try {
    const res = await HANDLERS.x402_check_health({ uptime_period: "30d" });
    assert.equal(res.content[0].text.includes("\n"), false, "text mirror must not be pretty-printed");
    assert.equal(res.content[0].text, JSON.stringify(res.structuredContent));
  } finally {
    restoreFetch();
  }
});

// ══ A-17#5: assess instruction derives the amount from accepts[0].amount (not a fixed $0.25) ══
function challenge(amount: string) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount,
        payTo: "0x0000000000000000000000000000000000000001",
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
    resource: { url: "https://x402-list.com/api/v1/assess" },
  };
}

test("A-17#5: assess instruction surfaces the base accepts[0].amount and drops the '$0.25' literal", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/assess") ? makeRes(402, challenge("250000"), { "PAYMENT-REQUIRED": "B64" }) : makeRes(404, {}),
  );
  try {
    const res = await HANDLERS.x402_assess_services({ question: "q", services: ["a-svc"] });
    const instr = res.structuredContent!.instruction as string;
    assert.ok(instr.includes("250000"), "instruction must cite the actual accepts[0].amount");
    assert.equal(instr.includes("$0.25"), false, "instruction must not hardcode a fixed dollar price");
    assert.ok(instr.includes("accepts[0].amount"));
  } finally {
    restoreFetch();
  }
});

test("A-17#5: when the probe raises the quote, the instruction reflects accepts[0].amount, not $0.25", async () => {
  // Server summed advisor + probe (e.g. 250000 + 1000000 = 1250000 atomic). The instruction must
  // carry the real quoted amount, so a budget-capped agent authorizes the right figure.
  installFetch((url) =>
    url.pathname.endsWith("/assess") ? makeRes(402, challenge("1250000"), { "PAYMENT-REQUIRED": "B64" }) : makeRes(404, {}),
  );
  try {
    const res = await HANDLERS.x402_assess_services({ question: "q", services: ["a-svc"], probe: { slug: "a-svc" } });
    const instr = res.structuredContent!.instruction as string;
    assert.ok(instr.includes("1250000"), "instruction must reflect the probe-inflated quote");
    assert.equal(instr.includes("$0.25"), false);
  } finally {
    restoreFetch();
  }
});

// ══ A-17#4: the 'no services match it' note is gated on an ACTUALLY empty list ═══════════
// NOTE ordering: this test keeps /networks failing throughout, so it leaves the process-level map
// cache EMPTY (failures are never cached) for the recovery test below. It must run before any test
// that warms the cache with a successful /networks fetch.
test("A-17#4: an unrecognized network with a non-empty result does NOT claim 'no services match'", async () => {
  // /networks empty (unreachable), so 'BSE' stays unrecognized, but the API filtered on the raw
  // value and returned rows. The note must not contradict the populated list.
  installFetch((url) => {
    if (url.pathname.endsWith("/networks")) return makeRes(500, { error: "down" });
    if (url.pathname.endsWith("/services")) {
      return makeRes(200, servicesBodyWith([{ ...fullServiceItem(), networks: ["BSE"] }]));
    }
    return makeRes(404, {});
  });
  try {
    const res = await HANDLERS.x402_search_services({ status: "all", sort: "newest", verified_only: false, page: 1, per_page: 25, network: "BSE" });
    const applied = res.structuredContent!.filters_applied as Record<string, unknown>;
    assert.equal(applied.network_recognized, false);
    assert.equal((res.structuredContent!.returned as number) > 0, true);
    assert.equal((res.structuredContent!.note as string).includes("no services match it"), false);
  } finally {
    restoreFetch();
  }
});

// ══ A-17#4: a transient /networks failure does NOT poison name resolution for the process ══
test("A-17#4: after a failed /networks fetch, a later call re-resolves the network (no permanent poison)", async () => {
  let netCalls = 0;
  installFetch((url) => {
    if (url.pathname.endsWith("/networks")) {
      netCalls++;
      // Fail the first two fetches (covers resolveNetwork AND knownNetworksHint on the first search),
      // then serve the real map. The OLD code cached the empty map forever after the first failure.
      if (netCalls <= 2) return makeRes(500, { error: { code: 500, message: "boom" } });
      return makeRes(200, {
        data: [{ id: "base", caip2_id: "eip155:8453", caip2: "eip155:8453", name: "Base", abbreviation: "BSE", chain_type: "evm", is_mainnet: true, explorer_url: null, service_count: 1, avg_uptime: null }],
      });
    }
    return url.pathname.endsWith("/services") ? makeRes(200, servicesBodyWith([])) : makeRes(404, {});
  });
  try {
    const args = { status: "all", sort: "newest", verified_only: false, page: 1, per_page: 25 };
    const first = await HANDLERS.x402_search_services({ ...args, network: "Base" });
    const firstApplied = first.structuredContent!.filters_applied as Record<string, unknown>;
    assert.equal(firstApplied.network_recognized, false, "while /networks is down, Base is unresolved");

    const second = await HANDLERS.x402_search_services({ ...args, network: "Base" });
    const secondApplied = second.structuredContent!.filters_applied as Record<string, unknown>;
    assert.equal(secondApplied.network_recognized, true, "once /networks recovers, Base resolves again");
    assert.equal(secondApplied.network, "BSE", "and resolves to the canonical abbreviation");
  } finally {
    restoreFetch();
  }
});
