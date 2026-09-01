// Wrapper tests for the API-first tools (MCP 0.4.0). x402_find_best_service and x402_assess_services are
// thin pass-throughs over the public HTTP API: x402_find_best_service forwards params to GET
// /api/v1/best and surfaces the server's ranking unchanged (all scoring moved server-side, locked
// byte-for-byte by the SHARED best.fixtures.json - see src/lib/ranking); x402_assess_services relays the
// x402 handshake to POST /api/v1/assess without ever signing or holding keys. These tests mock
// global.fetch and assert PARAM FORWARDING + RESPONSE RENDERING only, no scoring. The old client-
// side ranking asserts moved to the server test (src/lib/ranking/best.test.ts) against the same
// fixtures.
// Run with: npx tsx --test mcp/src/tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// ── harness: capture the registered tool handlers ────────────────────────────────
type ToolHandler = (args: Record<string, unknown>) => Promise<{
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: "text"; text: string }[];
}>;

// Tool DEFINITIONS are captured next to the handlers so a test can parse args against the strict
// zod inputSchema exactly as the SDK does, i.e. BEFORE the handler (and therefore any fetch) runs.
type ParsableSchema = { safeParse(v: unknown): { success: boolean } };
const DEFS: Record<string, { inputSchema?: ParsableSchema }> = {};

function collectTools(): Record<string, ToolHandler> {
  const handlers: Record<string, ToolHandler> = {};
  const fakeServer = {
    registerTool(name: string, def: { inputSchema?: ParsableSchema }, handler: ToolHandler) {
      DEFS[name] = def;
      handlers[name] = handler;
    },
  } as unknown as McpServer;
  registerTools(fakeServer);
  return handlers;
}
const TOOLS = collectTools();

// ── harness: mock global.fetch with a URL-routed responder + call recorder ────────
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

// The recommendation payload the server would return: use the shared fixture's expected output so
// the test proves the wrapper surfaces the server's ranking UNCHANGED (a pass-through parity check).
const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "best.fixtures.json"), "utf8"),
) as { cases: { expected_recommendations: unknown[]; expected_excluded_danger: string[] }[] };
const CORE = fixtures.cases[0];
const RANKING_BASIS = "Two stages. (1) RELEVANCE ... (2) QUALITY ...";

function bestBody(over: Record<string, unknown> = {}) {
  return {
    data: {
      recommendations: CORE.expected_recommendations,
      ranking_basis: RANKING_BASIS,
      excluded_danger: CORE.expected_excluded_danger,
      facilitator_context: null,
      ...over,
    },
    meta: { ranking_version: 1 },
    provenance: { license: "CC-BY-4.0", cite_as: "https://x402-list.com/api/v1/best" },
  };
}

const BEST_ARGS = {
  q: undefined,
  category: undefined,
  network: undefined,
  max_price_usd: undefined,
  require_verified: false,
  prefer: "balanced",
  limit: 5,
  include_facilitator_context: false,
};

// ── x402_find_best_service ─────────────────────────────────────────────────────────────

test("x402_find_best_service: forwards to GET /best and surfaces the server ranking verbatim", async () => {
  installFetch((url) => (url.pathname.endsWith("/best") ? makeRes(200, bestBody()) : makeRes(404, {})));
  try {
    const res = await TOOLS.x402_find_best_service({ ...BEST_ARGS });
    assert.equal(CALLS.length, 1);
    assert.ok(CALLS[0].url.pathname.endsWith("/api/v1/best"));
    assert.equal(CALLS[0].method, "GET");
    const sp = CALLS[0].url.searchParams;
    assert.equal(sp.get("prefer"), "balanced");
    assert.equal(sp.get("limit"), "5");
    // false booleans and absent filters are NOT sent (false = no filter, the API default).
    assert.equal(sp.get("require_verified"), null);
    assert.equal(sp.get("include_facilitator_context"), null);
    assert.equal(sp.get("q"), null);
    assert.equal(sp.get("category"), null);
    assert.equal(sp.get("network"), null);

    const out = res.structuredContent!;
    assert.deepEqual(out.recommendations, CORE.expected_recommendations);
    assert.equal(out.ranking_basis, RANKING_BASIS);
    assert.deepEqual(out.excluded_danger, CORE.expected_excluded_danger);
    assert.equal(out.facilitator_context, null);
    assert.equal(out.ranking_version, 1); // lifted from meta
    assert.equal("note" in out, false); // no note when the pool was non-empty
  } finally {
    restoreFetch();
  }
});

test("x402_find_best_service: forwards q / category / max_price_usd / prefer / limit / require_verified", async () => {
  installFetch((url) => (url.pathname.endsWith("/best") ? makeRes(200, bestBody()) : makeRes(404, {})));
  try {
    await TOOLS.x402_find_best_service({
      ...BEST_ARGS,
      q: "weather",
      category: "Data",
      max_price_usd: 0.5,
      prefer: "cheapest",
      limit: 3,
      require_verified: true,
    });
    const sp = CALLS[0].url.searchParams;
    assert.equal(sp.get("q"), "weather");
    assert.equal(sp.get("category"), "Data");
    assert.equal(sp.get("max_price_usd"), "0.5");
    assert.equal(sp.get("prefer"), "cheapest");
    assert.equal(sp.get("limit"), "3");
    assert.equal(sp.get("require_verified"), "true");
  } finally {
    restoreFetch();
  }
});

test("x402_find_best_service: resolves a network NAME to its abbreviation before forwarding", async () => {
  installFetch((url) => {
    if (url.pathname.endsWith("/networks")) {
      return makeRes(200, {
        data: [
          {
            id: "base",
            caip2_id: "eip155:8453",
            caip2: "eip155:8453",
            name: "Base",
            abbreviation: "BSE",
            chain_type: "evm",
            is_mainnet: true,
            explorer_url: null,
            service_count: 1,
            avg_uptime: null,
          },
        ],
      });
    }
    return url.pathname.endsWith("/best") ? makeRes(200, bestBody({ recommendations: [] })) : makeRes(404, {});
  });
  try {
    await TOOLS.x402_find_best_service({ ...BEST_ARGS, network: "Base" });
    const bestCall = CALLS.find((c) => c.url.pathname.endsWith("/best"))!;
    assert.equal(bestCall.url.searchParams.get("network"), "BSE");
  } finally {
    restoreFetch();
  }
});

test("x402_find_best_service: include_facilitator_context passes through and is surfaced (server merges)", async () => {
  const fac = [
    { facilitator_id: "f1", name: "Facil One", volume_usd_7d: 12.5, tx_count_7d: 3, verification: "on-chain" },
  ];
  installFetch((url) =>
    url.pathname.endsWith("/best") ? makeRes(200, bestBody({ facilitator_context: fac })) : makeRes(404, {}),
  );
  try {
    const res = await TOOLS.x402_find_best_service({ ...BEST_ARGS, include_facilitator_context: true });
    assert.equal(CALLS[0].url.searchParams.get("include_facilitator_context"), "true");
    assert.deepEqual(res.structuredContent!.facilitator_context, fac);
  } finally {
    restoreFetch();
  }
});

test("x402_find_best_service: an empty result surfaces the server note", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/best")
      ? makeRes(
          200,
          bestBody({ recommendations: [], excluded_danger: [], note: "No services matched the given filters." }),
        )
      : makeRes(404, {}),
  );
  try {
    const res = await TOOLS.x402_find_best_service({ ...BEST_ARGS });
    assert.deepEqual(res.structuredContent!.recommendations, []);
    assert.equal(res.structuredContent!.note, "No services matched the given filters.");
  } finally {
    restoreFetch();
  }
});

// ── x402_search_services: the ?signable= pass-through (C-compliance, 28/7) ─────────
// The param carries NO client-side logic by decision: whatever the API answers is the answer.
// What these tests pin is exactly that it reaches the wire, including the `false` value, which a
// `x ? x : undefined` shorthand (correct for verified_only, wrong here) would silently drop and
// turn into an unfiltered list reported as filtered.

const SEARCH_ARGS = {
  q: undefined,
  category: undefined,
  network: undefined,
  status: "all",
  verified_only: false,
  sort: "newest",
  page: 1,
  per_page: 25,
};

function servicesBody() {
  return { data: [], meta: { page: 1, per_page: 25, total: 0, total_pages: 0 } };
}

test("x402_search_services: signable=true reaches the API and is echoed in filters_applied", async () => {
  installFetch((url) => (url.pathname.endsWith("/services") ? makeRes(200, servicesBody()) : makeRes(404, {})));
  try {
    const res = await TOOLS.x402_search_services({ ...SEARCH_ARGS, signable: true });
    assert.equal(CALLS.length, 1);
    assert.ok(CALLS[0].url.pathname.endsWith("/api/v1/services"));
    assert.equal(CALLS[0].url.searchParams.get("signable"), "true");
    const applied = res.structuredContent!.filters_applied as Record<string, unknown>;
    assert.equal(applied.signable, true);
  } finally {
    restoreFetch();
  }
});

test("x402_search_services: signable=false is forwarded, not dropped as a falsy value", async () => {
  installFetch((url) => (url.pathname.endsWith("/services") ? makeRes(200, servicesBody()) : makeRes(404, {})));
  try {
    const res = await TOOLS.x402_search_services({ ...SEARCH_ARGS, signable: false });
    assert.equal(CALLS[0].url.searchParams.get("signable"), "false");
    const applied = res.structuredContent!.filters_applied as Record<string, unknown>;
    assert.equal(applied.signable, false);
  } finally {
    restoreFetch();
  }
});

test("x402_search_services: omitting signable sends no signable param at all", async () => {
  installFetch((url) => (url.pathname.endsWith("/services") ? makeRes(200, servicesBody()) : makeRes(404, {})));
  try {
    const res = await TOOLS.x402_search_services({ ...SEARCH_ARGS });
    assert.equal(CALLS[0].url.searchParams.has("signable"), false);
    const applied = res.structuredContent!.filters_applied as Record<string, unknown>;
    assert.equal(applied.signable, null);
  } finally {
    restoreFetch();
  }
});

// ── x402_assess_services (paid pass-through) ────────────────────────────────────────────

const CHALLENGE_402 = {
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      amount: "250000",
      payTo: "0x0000000000000000000000000000000000000001",
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
  resource: { url: "https://x402-list.com/api/v1/assess" },
};

test("x402_assess_services: no signature -> POSTs unpaid and returns the 402 challenge verbatim", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/assess")
      ? makeRes(402, CHALLENGE_402, { "PAYMENT-REQUIRED": "BASE64-CHALLENGE" })
      : makeRes(404, {}),
  );
  try {
    const res = await TOOLS.x402_assess_services({ question: "which is cheapest?", services: ["a-svc", "b-svc"] });
    assert.equal(CALLS.length, 1);
    assert.ok(CALLS[0].url.pathname.endsWith("/api/v1/assess"));
    assert.equal(CALLS[0].method, "POST");
    // Unpaid: no PAYMENT-SIGNATURE header.
    assert.equal("PAYMENT-SIGNATURE" in CALLS[0].headers, false);
    assert.deepEqual(JSON.parse(CALLS[0].body!), { question: "which is cheapest?", services: ["a-svc", "b-svc"] });

    const out = res.structuredContent!;
    assert.equal(out.status, 402);
    assert.deepEqual(out.payment_required, CHALLENGE_402);
    assert.equal(out.payment_required_header_b64, "BASE64-CHALLENGE");
    assert.equal(typeof out.instruction, "string");
    assert.ok((out.instruction as string).includes("accepts[0]"));
    assert.equal("note" in out, false); // no signature was supplied -> no rejected note
  } finally {
    restoreFetch();
  }
});

test("x402_assess_services: with signature -> POSTs PAYMENT-SIGNATURE and returns data + PAYMENT-RESPONSE", async () => {
  const report = {
    data: { answer: { question: "q", recommendation: { value: "a-svc", confidence: 0.7, source: "ai" } } },
    meta: { report_version: 1, modules_run: ["advisor"] },
    provenance: { license: "CC-BY-4.0", cite_as: "https://x402-list.com/api/v1/assess" },
  };
  installFetch((url) =>
    url.pathname.endsWith("/assess")
      ? makeRes(200, report, { "PAYMENT-RESPONSE": "BASE64-RECEIPT" })
      : makeRes(404, {}),
  );
  try {
    const res = await TOOLS.x402_assess_services({
      question: "q",
      services: ["a-svc"],
      payment_signature_b64: "SIGNED-B64",
    });
    assert.equal(CALLS[0].headers["PAYMENT-SIGNATURE"], "SIGNED-B64");
    const out = res.structuredContent!;
    assert.equal(out.status, 200);
    assert.deepEqual(out.data, report.data);
    assert.deepEqual(out.meta, report.meta);
    assert.deepEqual(out.provenance, report.provenance);
    assert.equal(out.payment_response_b64, "BASE64-RECEIPT");
  } finally {
    restoreFetch();
  }
});

test("x402_assess_services: a 503 (dark / uncharged miss) is surfaced as a tool error", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/assess")
      ? makeRes(503, { error: { code: 503, message: "on-demand assessment temporarily unavailable" } })
      : makeRes(404, {}),
  );
  try {
    const res = await TOOLS.x402_assess_services({ question: "q", services: ["a-svc"] });
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes("temporarily unavailable"));
  } finally {
    restoreFetch();
  }
});

test("x402_assess_services: signature supplied but server did not settle (402) -> challenge + rejected note", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/assess")
      ? makeRes(402, CHALLENGE_402, { "PAYMENT-REQUIRED": "BASE64-CHALLENGE" })
      : makeRes(404, {}),
  );
  try {
    const res = await TOOLS.x402_assess_services({ question: "q", services: ["a-svc"], payment_signature_b64: "BAD-SIG" });
    const out = res.structuredContent!;
    assert.equal(out.status, 402);
    assert.equal(typeof out.note, "string");
    assert.ok((out.note as string).includes("did not settle"));
  } finally {
    restoreFetch();
  }
});

// ── x402_assess_services: optional live-probe block (treno 4, verbatim pass-through) ─────

test("x402_assess_services: forwards the optional probe block verbatim in the POST body", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/assess")
      ? makeRes(402, CHALLENGE_402, { "PAYMENT-REQUIRED": "BASE64-CHALLENGE" })
      : makeRes(404, {}),
  );
  try {
    await TOOLS.x402_assess_services({
      question: "which is cheapest and does it actually work?",
      services: ["a-svc", "b-svc"],
      probe: { slug: "a-svc", endpoint_path: "/v1/quote" },
    });
    assert.equal(CALLS[0].method, "POST");
    // The package adds no probe logic: the block goes on the wire exactly as received.
    assert.deepEqual(JSON.parse(CALLS[0].body!), {
      question: "which is cheapest and does it actually work?",
      services: ["a-svc", "b-svc"],
      probe: { slug: "a-svc", endpoint_path: "/v1/quote" },
    });
  } finally {
    restoreFetch();
  }
});

test("x402_assess_services: a probe with only a slug is forwarded verbatim (no endpoint_path)", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/assess")
      ? makeRes(402, CHALLENGE_402, { "PAYMENT-REQUIRED": "BASE64-CHALLENGE" })
      : makeRes(404, {}),
  );
  try {
    await TOOLS.x402_assess_services({ question: "q", services: ["a-svc"], probe: { slug: "a-svc" } });
    assert.deepEqual(JSON.parse(CALLS[0].body!), {
      question: "q",
      services: ["a-svc"],
      probe: { slug: "a-svc" },
    });
  } finally {
    restoreFetch();
  }
});

test("x402_assess_services: without a probe the body carries no probe key (unchanged flow)", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/assess")
      ? makeRes(402, CHALLENGE_402, { "PAYMENT-REQUIRED": "BASE64-CHALLENGE" })
      : makeRes(404, {}),
  );
  try {
    await TOOLS.x402_assess_services({ question: "q", services: ["a-svc"] });
    assert.equal("probe" in JSON.parse(CALLS[0].body!), false);
  } finally {
    restoreFetch();
  }
});

// ── x402_change_events (T1a drift feed) ─────────────────────────────────────────────
// The trap these tests exist for: the API's per-service filter is named `service`, and an unknown
// query param is IGNORED rather than rejected, so a `slug=` would come back 200 with the WHOLE
// unfiltered feed and be rendered here as if it were filtered. What is pinned: the wire name, the
// pre-flight rejection of an out-of-set type (no request leaves at all), and that the reported
// total is the server's filtered total, never the length of the page.

const CHANGES_ARGS = { days: 90, page: 1, per_page: 25 };

function changeEvent(over: Record<string, unknown> = {}) {
  return {
    slug: "exa",
    name: "Exa",
    type: "payto_changed",
    observed_at: "2026-08-21T10:11:00.524Z",
    // payTo values arrive MASKED from the API (deliberate); the fixture keeps them masked.
    summary: { payToAdded: ["0x75D9...817f"], payToRemoved: ["0x5106...cbb1"] },
    old_snapshot: [{ endpoint: "GET /search", payTo: "0x5106...cbb1", price: "50000", assetName: "USDC" }],
    new_snapshot: [{ endpoint: "GET /search", payTo: "0x75D9...817f", price: "50000", assetName: "USDC" }],
    ...over,
  };
}
// meta.total (4425) is deliberately unrelated to data.length (2): the tool must report the server's
// filtered total for the window, not the size of the page it happens to be holding.
function changesBody(over: Record<string, unknown> = {}) {
  return {
    data: [changeEvent(), changeEvent({ type: "price_changed", observed_at: "2026-08-20T09:00:00.000Z" })],
    meta: { total: 4425, page: 1, per_page: 25, total_pages: 177, days: 90 },
    ...over,
  };
}
function installChangesFetch(): void {
  installFetch((url) => (url.pathname.endsWith("/changes") ? makeRes(200, changesBody()) : makeRes(404, {})));
}

test("x402_change_events: the service filter goes on the wire as ?service=, never as ?slug=", async () => {
  installChangesFetch();
  try {
    const res = await TOOLS.x402_change_events({ ...CHANGES_ARGS, service: "exa" });
    assert.equal(CALLS.length, 1);
    assert.ok(CALLS[0].url.pathname.endsWith("/api/v1/changes"));
    assert.equal(CALLS[0].method, "GET");
    const sp = CALLS[0].url.searchParams;
    // The whole point: `service` is the name the API filters on. `slug` is silently ignored
    // upstream and would yield the entire unfiltered feed with a 200.
    assert.equal(sp.get("service"), "exa");
    assert.equal(sp.has("slug"), false);
    const applied = res.structuredContent!.filters_applied as Record<string, unknown>;
    assert.equal(applied.service, "exa");
  } finally {
    restoreFetch();
  }
});

test("x402_change_events: forwards type, days, page and per_page verbatim", async () => {
  installChangesFetch();
  try {
    await TOOLS.x402_change_events({ service: "exa", type: "price_changed", days: 7, page: 2, per_page: 50 });
    const sp = CALLS[0].url.searchParams;
    assert.equal(sp.get("type"), "price_changed");
    assert.equal(sp.get("days"), "7");
    assert.equal(sp.get("page"), "2");
    assert.equal(sp.get("per_page"), "50");
  } finally {
    restoreFetch();
  }
});

test("x402_change_events: with no filters neither service nor type reaches the wire", async () => {
  installChangesFetch();
  try {
    const res = await TOOLS.x402_change_events({ ...CHANGES_ARGS });
    const sp = CALLS[0].url.searchParams;
    assert.equal(sp.has("service"), false);
    assert.equal(sp.has("type"), false);
    assert.equal(sp.get("days"), "90");
    const applied = res.structuredContent!.filters_applied as Record<string, unknown>;
    assert.equal(applied.service, null);
    assert.equal(applied.type, null);
  } finally {
    restoreFetch();
  }
});

test("x402_change_events: a type outside the 3-value set is rejected by the schema, before any request", async () => {
  const schema = DEFS.x402_change_events.inputSchema!;
  installChangesFetch(); // arms the recorder; nothing must reach it
  try {
    for (const t of ["payto_changed", "price_changed", "schema_changed"]) {
      assert.equal(schema.safeParse({ type: t }).success, true, `${t} is a valid type`);
    }
    // Near-misses and free text alike are refused at the boundary (-32602), so the API's own 400
    // ("Invalid type ... Use: payto_changed, price_changed, schema_changed") is never needed.
    assert.equal(schema.safeParse({ type: "payto" }).success, false);
    assert.equal(schema.safeParse({ type: "PRICE_CHANGED" }).success, false);
    assert.equal(schema.safeParse({ type: "" }).success, false);
    // Same boundary catches the wrong service param name: strict() rejects `slug` instead of
    // dropping it and answering with an unfiltered feed.
    assert.equal(schema.safeParse({ slug: "exa" }).success, false);
    assert.equal(schema.safeParse({ service: "exa" }).success, true);
    assert.equal(CALLS.length, 0, "an invalid type must never produce a network call");
  } finally {
    restoreFetch();
  }
});

test("x402_change_events: total is the server's meta.total, not the number of events on the page", async () => {
  installChangesFetch();
  try {
    const res = await TOOLS.x402_change_events({ ...CHANGES_ARGS, service: "exa" });
    const out = res.structuredContent!;
    assert.equal((out.changes as unknown[]).length, 2);
    assert.equal(out.total, 4425); // meta.total, NOT data.length
    assert.equal(out.returned, 2); // the page length, reported separately
    assert.equal(out.page, 1);
    assert.equal(out.per_page, 25);
    assert.equal(out.total_pages, 177);
    assert.equal(out.days, 90);
    // Events pass through untouched (masked payTo, atomic prices, per-type summary shape).
    assert.deepEqual((out.changes as unknown[])[0], changeEvent());
  } finally {
    restoreFetch();
  }
});

test("x402_change_events: an API error is surfaced as a tool error, not as an empty feed", async () => {
  installFetch((url) =>
    url.pathname.endsWith("/changes")
      ? makeRes(400, { error: { code: 400, message: "Invalid type 'nope'. Use: payto_changed, price_changed, schema_changed" } })
      : makeRes(404, {}),
  );
  try {
    const res = await TOOLS.x402_change_events({ ...CHANGES_ARGS, type: "nope" });
    assert.equal(res.isError, true);
    assert.ok(res.content[0].text.includes("Invalid type"));
  } finally {
    restoreFetch();
  }
});
