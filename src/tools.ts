// The 7 x402-list MCP tools: schemas, handlers, response mapping.
//
// USD PASS-THROUGH RULE: every *_usd field is copied straight from the API value.
// No Math.round, no multiply, no divide. pricing[].price is copied as the raw
// atomic-token string and labeled accordingly. There is intentionally no /100,
// no * 100, and no cents conversion anywhere in this file.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ApiError,
  getServices,
  getService,
  getServiceUptime,
  getServiceVolumeSeries,
  getServiceBuyersSeries,
  getFacilitators,
  getStatus,
  getNetworks,
  getBest,
  getChanges,
  postAssess,
  type ServiceListItem,
} from "./api.js";
import { trackTool } from "./track.js";

// Network input normalization.
// The API and ServiceListItem.networks[] use ABBREVIATIONS (e.g. "BSE", "SOL"),
// but agents naturally pass the human name ("Base"). The API silently ignores an
// unknown `network` value and returns everything, so without this an unfiltered
// result would be reported as if the filter were honored. We resolve either form
// to the canonical abbreviation, fetched once and cached for the process.
// A-17#4: the map is cached with a TTL and, crucially, a FAILED or empty fetch is NEVER cached.
// The old code memoized a single Promise for the whole process life, so one transient /networks
// timeout resolved to an EMPTY Map that stayed cached until redeploy, permanently breaking network
// name resolution (every 'Base' then read as unknown). Here a successful, non-empty fetch is cached
// for NETWORK_MAP_TTL_MS (the live network set grows over time, so a TTL also lets it refresh); a
// failure or an empty result leaves the cache untouched so the very next call retries. Concurrent
// callers share one in-flight fetch (dedup) without persisting its outcome on failure.
const NETWORK_MAP_TTL_MS = 5 * 60 * 1000;
let networkMapCache: { map: Map<string, string>; expiresAt: number } | null = null;
let networkMapInflight: Promise<Map<string, string>> | null = null;
function getNetworkMap(): Promise<Map<string, string>> {
  const now = Date.now();
  if (networkMapCache && networkMapCache.expiresAt > now) return Promise.resolve(networkMapCache.map);
  if (networkMapInflight) return networkMapInflight;
  networkMapInflight = (async () => {
    const m = new Map<string, string>();
    try {
      const resp = await getNetworks();
      for (const n of resp.data) {
        const abbr = typeof n?.abbreviation === "string" ? n.abbreviation : null;
        if (!abbr) continue;
        m.set(abbr.toLowerCase(), abbr);
        if (typeof n?.name === "string") m.set(n.name.toLowerCase(), abbr);
        if (typeof n?.caip2_id === "string") m.set(n.caip2_id.toLowerCase(), abbr);
      }
      // Cache ONLY a real, non-empty result. An empty map means the endpoint gave nothing usable
      // (or threw, caught below): treat it as a miss so the next call re-fetches instead of serving
      // a poisoned empty map for the process life.
      if (m.size > 0) networkMapCache = { map: m, expiresAt: Date.now() + NETWORK_MAP_TTL_MS };
    } catch {
      // Networks endpoint unreachable: return an empty map WITHOUT caching it. resolveNetwork then
      // treats the input as a raw abbreviation (still correct for "BSE"-style input), and the next
      // call retries a fresh fetch rather than being stuck on this one transient failure.
    } finally {
      // Release the in-flight handle regardless of outcome. On success the TTL cache serves the next
      // call; on failure the null handle forces a fresh retry (no poisoned promise lingers).
      networkMapInflight = null;
    }
    return m;
  })();
  return networkMapInflight;
}
async function resolveNetwork(input: string): Promise<{ abbrev: string; recognized: boolean }> {
  const key = input.trim().toLowerCase();
  const hit = (await getNetworkMap()).get(key);
  return hit ? { abbrev: hit, recognized: true } : { abbrev: input.trim(), recognized: false };
}
// Human-readable list of the currently-known network codes, built from the same
// cached /networks map that resolveNetwork uses, so error notes never drift
// from the live network set (which grows over time).
async function knownNetworksHint(): Promise<string> {
  const abbrs = [...new Set((await getNetworkMap()).values())].sort();
  return abbrs.length > 0
    ? `known network codes: ${abbrs.join(", ")}; full names from /api/v1/networks are also accepted`
    : "the network list could not be fetched from /api/v1/networks";
}

function ok(structured: unknown) {
  // A-17#3: the tool result already carries the object once as structuredContent. The text block
  // is the backward-compat mirror for clients that ignore structuredContent, so it must stay, but
  // it is emitted as COMPACT JSON (no pretty indentation) rather than a second pretty-printed copy:
  // the pretty form roughly doubled the payload weight on top of the structured copy (221 KB for a
  // directory snapshot). Same data, one un-indented mirror.
  return {
    structuredContent: structured as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(structured) }],
  };
}
function fail(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}
function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// B-14#4: the compact projection for x402_search_services. Keeps the decision-useful scalars
// (identity, price, status, uptime, response time, verification, networks, endpoint count) plus the
// two ranking-relevant assessment scalars (compliance grade, risk level), and DROPS the long
// description and the heavy nested assessment block. Callers that need the full assessment pass
// fields='full' here or call x402_get_service for one service. USD fields stay pass-through (no rescale).
function toCompactService(s: ServiceListItem) {
  return {
    slug: s.slug,
    name: s.name,
    category: s.category,
    status: s.status,
    verified: s.verified,
    endpoint_count: s.endpoint_count,
    min_price_usd: s.min_price_usd, // decimal USD, verbatim
    networks: s.networks,
    uptime_24h: s.uptime_24h,
    avg_response_time_ms: s.avg_response_time_ms,
    base_url: s.base_url,
    website_url: s.website_url,
    created_at: s.created_at,
    compliance_grade: s.assessment?.compliance_grade ?? null,
    risk_level: s.assessment?.risk_level ?? null,
  };
}

// Pull a human message out of an API error/control body ({error:{code,message}}, {error, message},
// or {message}). Used by x402_assess_services to surface a 400/503 answer to the agent.
function extractApiMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.message === "string" && b.message) return b.message;
  const err = b.error;
  if (err && typeof err === "object") {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string" && m) return m;
  }
  if (typeof err === "string" && err) return err;
  return null;
}

// ── x402_assess_services copy (user-facing; census in docs/COPY-REVIEW-t1c-t2.md and COPY-REVIEW-T5) ──
// A-17#5: the instruction is DERIVED from accepts[0] of the live challenge, never a hardcoded
// "$0.25". When a live probe is armed the server quotes $0.25 + the endpoint price X, so a fixed
// dollar figure in the instruction contradicts the amount the caller must actually sign, on a
// non-refundable spend. We surface accepts[0].amount (the authoritative atomic amount) verbatim and
// point the caller at it. No atomic->USD math here (USD PASS-THROUGH rule, top of file).
function firstAccept(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const accepts = (body as Record<string, unknown>).accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const a = accepts[0];
  return a && typeof a === "object" ? (a as Record<string, unknown>) : null;
}
function buildAssessInstruction(body: unknown): string {
  const a = firstAccept(body);
  const amount = a && typeof a.amount === "string" ? a.amount : null;
  const asset = a && typeof a.asset === "string" ? a.asset : null;
  const network = a && typeof a.network === "string" ? a.network : null;
  const quoted = amount
    ? `This challenge quotes accepts[0].amount = ${amount} atomic units${asset ? ` of asset ${asset}` : ""}${network ? ` on ${network}` : ""}, which is the authoritative amount to sign and, when a live probe is requested, already includes the probe endpoint price X. `
    : "";
  return `Payment required. ${quoted}Sign the single accepts[0] option in THIS challenge client-side with your own x402-capable wallet, then call x402_assess_services again with the same question and services and set payment_signature_b64 to the base64 PAYMENT-SIGNATURE you produced. Read the amount from accepts[0].amount, not from any fixed price. This server never holds keys and never signs: it only relays the challenge. There is no refund.`;
}
const ASSESS_SIGNATURE_REJECTED_NOTE =
  "A payment_signature_b64 was supplied but the server did not settle (the signature did not verify, funds were insufficient, or the quoted price changed). Re-sign the accepts[0] option in this fresh challenge and retry.";

export function registerTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // 3.1 x402_search_services
  // -------------------------------------------------------------------------
  server.registerTool(
    "x402_search_services",
    {
      title: "Search x402 services",
      description:
        "Your first call when you do not know which x402 service exists for a job: it narrows a directory of 500+ listed services to candidates. Filter by free-text query, category, network, live status, and whether the last observed 402 envelope is signable by a standard x402 client; sort by newest, uptime, cheapest, or endpoints. Returns up to 100 compact summaries a page: price in decimal USD, uptime, status, verification. Then x402_get_service for the full record.",
      // B-14#1: inputSchema is a STRICT object, so an unknown top-level key (e.g. 'networks' for
      // 'network') is rejected with a JSON-RPC -32602 instead of being silently dropped and the
      // query answered as if the filter were honored. The advertised additionalProperties:false is
      // now enforced at runtime, not just declared.
      inputSchema: z.object({
        q: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Free-text search across name, description, category, base_url."),
        category: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("Exact category name (see categories context). Omit for all."),
        network: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Network name or abbreviation, e.g. 'Base' or 'BSE'; any network code returned by /api/v1/networks is accepted. Omit for all.",
          ),
        status: z
          .enum(["online", "degraded", "offline", "unknown", "all"])
          .default("all")
          .describe("Filter by live monitoring status."),
        verified_only: z
          .boolean()
          .default(false)
          .describe(
            "If true, return only verified services. Filtered server-side, so the result total covers the whole verified set, not just this page.",
          ),
        signable: z
          .boolean()
          .optional()
          .describe(
            "Filter on the signability of the last observed 402 envelope: true = no EVM route of the service was observed missing the EIP-712 domain parameters (extra.name and extra.version) that a standard x402 client requires in order to sign a payment, false = at least one such route was observed. It describes the payment envelope on the wire, not the merit of the service. A service whose latest assessment has not measured that check yet matches NEITHER value, so omit this parameter to include it. Filtered server-side, so the result total covers the whole filtered set.",
          ),
        sort: z
          .enum(["newest", "uptime", "cheapest", "endpoints"])
          .default("newest")
          .describe("Server-side sort order."),
        // B-14#4: response weight. `compact` (default) returns lean per-service summaries and drops
        // the heavy per-service assessment block (a full page could exceed 87k tokens and be
        // truncated mid-JSON by the client); `full` restores every field verbatim, matching
        // x402_get_service. Use compact to survey, then x402_get_service for one service's full detail.
        fields: z
          .enum(["compact", "full"])
          .default("compact")
          .describe(
            "Response detail: 'compact' (default) = lean summaries (identity, price, status, uptime, verification, networks, compliance grade), 'full' = every field including the per-service assessment block. Compact keeps a directory sweep small enough to not truncate.",
          ),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("1-based page index into the filtered result set (see meta.total_pages)."),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe(
            "Services per page, 1 to 100 (default 25). Higher values return larger results; with fields='full' a large page can be very heavy, so prefer compact when raising it.",
          ),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      trackTool("x402_search_services", {
        category: args.category ?? null,
        network: args.network ?? null,
        status: args.status,
        sort: args.sort,
        verified_only: args.verified_only,
        signable: args.signable ?? null,
        has_query: Boolean(args.q),
        fields: args.fields ?? "compact",
      });
      try {
        const status = args.status === "all" ? undefined : args.status;
        const net = args.network ? await resolveNetwork(args.network) : null;
        const resp = await getServices({
          q: args.q,
          category: args.category,
          network: net?.abbrev,
          status,
          sort: args.sort,
          page: args.page,
          per_page: args.per_page,
          // Server-side filter (audit C17). Only sent when true: verified_only=false
          // means "no filter", not "unverified only".
          verified: args.verified_only ? true : undefined,
          // Signability filter (C-compliance), pure pass-through: BOTH values are real filters
          // here, so false is forwarded as-is and only an omitted param means "no filter". No
          // client-side re-assertion on purpose (decision 28/7): the API is the single authority
          // on the answer, which is also why this package publishes only after the API ships it.
          signable: args.signable,
        });
        let services: ServiceListItem[] = resp.data;
        // Re-assert the network filter client-side: the API silently ignores an
        // unknown value, so never let an unfiltered list pass as filtered.
        if (net) services = services.filter((s) => s.networks.includes(net.abbrev));
        const fields = args.fields ?? "compact";
        const notes = ["min_price_usd values are decimal US dollars."];
        if (fields === "compact") {
          notes.push(
            "fields='compact': per-service assessment block omitted; call with fields='full' or use x402_get_service for the full assessment.",
          );
        }
        // A-17#4: only claim "no services match it" when the list is ACTUALLY empty. An unrecognized
        // network name can still coincide with a raw abbreviation the API filtered on server-side
        // (or the /networks map was momentarily unavailable), leaving services non-empty. Guarding
        // on services.length keeps the note from contradicting a populated list.
        if (net && !net.recognized && services.length === 0) {
          notes.push(
            `network '${args.network}' did not match any known network (${await knownNetworksHint()}); no services match it.`,
          );
        } else if (net && !net.recognized) {
          notes.push(
            `network '${args.network}' was not in the known network set (${await knownNetworksHint()}); results were filtered server-side on the raw value.`,
          );
        }
        const servicesOut = fields === "compact" ? services.map(toCompactService) : services;
        return ok({
          services: servicesOut, // compact projection or full fields verbatim; min_price_usd in decimal USD
          fields,
          meta: resp.meta,
          returned: servicesOut.length,
          filters_applied: {
            q: args.q ?? null,
            category: args.category ?? null,
            network: net ? net.abbrev : null,
            network_recognized: net ? net.recognized : null,
            status: args.status,
            sort: args.sort,
            verified_only: args.verified_only,
            signable: args.signable ?? null,
          },
          note: notes.join(" "),
        });
      } catch (e) {
        return fail(`x402_search_services failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.2 x402_get_service
  // -------------------------------------------------------------------------
  server.registerTool(
    "x402_get_service",
    {
      title: "Get x402 service",
      description:
        "Call this once you hold a slug and are deciding whether to commit to that service: the full record behind a directory row. Live status, uptime over 24h/7d/30d/90d, average response time, networks and settlement asset, every priced endpoint, and the assessment block. include_series=true adds 90 daily points of on-chain volume and distinct buyers. Read the units map in the response: the per-endpoint price field is atomic token units, not dollars.",
      // B-14#1: STRICT object - an unknown top-level key is rejected (-32602), not silently dropped.
      inputSchema: z.object({
        slug: z.string().trim().min(1).max(200).describe("Service slug, e.g. 'my-api'."),
        include_series: z
          .boolean()
          .default(false)
          .describe(
            "If true, also attach this service's daily on-chain series under `series` (settlement volume and distinct buyers, one point per UTC day over the most recent 90 days, oldest first). Off by default to keep the response small.",
          ),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      trackTool("x402_get_service", {
        slug: String(args.slug).slice(0, 128),
        include_series: args.include_series,
      });
      try {
        const resp = await getService(args.slug);
        const units: Record<string, string> = {
          min_price_usd: "decimal US dollars (number)",
          "pricing.price_usd": "decimal US dollars (string)",
          "pricing.price":
            "ATOMIC on-chain token units (uint256 string), NOT dollars, do not rescale",
          uptime:
            "percentages 0-100 for windows 24h/7d/30d/90d; null = not yet monitored in that window (0 = observed down)",
          assessment:
            "per-service evidence-backed assessment (reliability, x402 compliance, site/docs, domain, economics, risk, plus an AI synthesis); null until the service is first assessed. Measured fields are plain values; 'unknown'/null are honest, not zero.",
          "assessment.economics":
            "price_usd/category_percentile are the ENTRY (min) price and its in-category rank; price_max_usd/category_percentile_max carry the highest tier and its rank; endpoint_count and distinct_price_count (1 = flat, >1 = tiered) describe the price spread. All decimal USD; new fields are null on rows assessed before they existed.",
          "assessment.synthesis.*":
            "AI-derived (family 10): each field is {value, confidence 0-1, source:'ai'}; value may be 'unknown' when the model could not ground it in the measured signals. An AI-derived field NEVER overrides a measured value.",
          "assessment.traction":
            "Fase 2 (family 6): on-chain settlement traction measured over this service's known payTo addresses via recognized settlers. All *_usd/count fields are a CONSERVATIVE UNDERCOUNT (unattributed settlements are not counted, never estimated up). volume_usd_30d = decimal USD over the last 30 UTC days; tx_count_30d/unique_buyers_30d = counts over 30d; last_settlement_at = ISO 8601 of the most recent settlement; top_buyer_share_30d = 0-1 concentration of the largest buyer; trend_7d_vs_30d = last-7d daily rate over the 30d daily rate; measured_networks = canonical CAIP-2 chains that contributed. status: 'measured' = real numbers where 0 is an HONEST zero; 'no-payto'/'unmeasured-network' = null, never a fake zero; 'unresponsive' = a shared-payout member whose probe has been failing for 7 days, so its share is suppressed (null). shared_payout=true means the payTo is shared across N services; only volume_usd_30d is then attributed PRO-QUOTA (the operator-level volume over the shared address, divided across the services sharing it) - a declared convention, not an individually observed measure - while tx_count_30d and unique_buyers_30d stay WHOLE operator-level counts (never fractional), and pro_quota_share carries the cluster fraction (1/(shared_with+1)) a consumer can apply to those counts for a per-service split. top_buyer_share_30d and trend_7d_vs_30d are ratios, invariant under the split. Beyond the 30d figures the traction block carries `first_settlement_at`, all-time `volume_usd_all_time` (pro-quota on a shared payout, like the 30d volume) and `tx_count_all_time` (a whole operator-level count), the per-settlement `median_settlement_usd_30d` / `max_settlement_usd_30d` (invariant amounts, never divided), the `settled_via` facilitator list (volume first), and `shared_with_services` (the sibling listed services on a shared payout address).",
        };
        const payload: Record<string, unknown> = {
          service: resp.data, // full ServiceDetail verbatim (includes `assessment` when present)
          units,
        };
        // include_series: attach the daily on-chain series (read-only passthrough). Fail-soft per
        // series - a fetch failure attaches null (never a fabricated 0), the detail still returns.
        if (args.include_series) {
          const [volRes, buyRes] = await Promise.allSettled([
            getServiceVolumeSeries(args.slug),
            getServiceBuyersSeries(args.slug),
          ]);
          payload.series = {
            volume: volRes.status === "fulfilled" ? volRes.value : null,
            buyers: buyRes.status === "fulfilled" ? buyRes.value : null,
          };
          units["series.volume"] =
            "Present only when include_series=true. Daily on-chain settlement volume: { data: [{date (UTC day), volume_usd (decimal USD), tx_count}], caveat }, oldest first, over the most recent 90 days. Operator-level and a conservative undercount: do not sum across services that share a payout address. null when the series could not be fetched (never a fabricated 0).";
          units["series.buyers"] =
            "Present only when include_series=true. Daily distinct on-chain buyers: { data: [{date (UTC day), unique_buyers}], caveat }, oldest first, over the most recent 90 days. unique_buyers is exact for a single-address service and an upper bound for a multi-address one; a conservative undercount. null when the series could not be fetched (never a fabricated 0).";
        }
        return ok(payload);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          return fail(`Service '${args.slug}' not found.`);
        }
        return fail(`x402_get_service failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.3 x402_find_best_service (reliability/compliance/price primary; on-chain traction weighs ~10%,
  //     shared-payout traction is attributed pro-quota; unmeasured/suppressed carry no term)
  // -------------------------------------------------------------------------
  server.registerTool(
    "x402_find_best_service",
    {
      title: "Find best x402 service",
      description:
        "Call this when you have a need in words and want one service to call rather than a list to read: it is the free ranking step between searching and paying. Pass the need as q, plus any category, network, price cap or verification requirement, and get up to 20 ranked recommendations with the basis each one placed on. Ranking is mostly per-service reliability (live status, verification, uptime, response time), x402 compliance, and price in USD, with a small (about 10%) weight on measured on-chain settlement traction that can never dominate those three. The response carries ranking_version (currently 3), need_blind_ranking (true when no q was given, so the order is global quality rather than your need), and a units map holding every scoring caveat in full: the compliance cap, the pro-quota rule for shared payout addresses, renormalization, the $10 volume floor, and the single-buyer discount. Read units before comparing scores across generations.",
      // B-16#0 + B-14#1: STRICT object. A wrong arg NAME (e.g. 'query' for 'q') is now rejected with
      // -32602 instead of being dropped and answered as a need-blind global ranking that scored
      // HIGHER than the correct relevance-matched answer. The strict boundary closes the silent
      // arg-name mismatch; the response also carries need_blind_ranking (below) for the legitimate
      // no-'q' case.
      inputSchema: z.object({
        category: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe("Desired service category."),
        network: z
          .string()
          .trim()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Required network name or abbreviation, e.g. 'Base' or 'BSE'; any network code returned by /api/v1/networks is accepted.",
          ),
        q: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Free-text need description to match against name/description."),
        max_price_usd: z
          .number()
          .min(0)
          .optional()
          .describe("Cap on min_price_usd in US dollars; cheaper or equal passes."),
        require_verified: z
          .boolean()
          .default(false)
          .describe("If true, only verified services are eligible."),
        prefer: z
          .enum(["balanced", "cheapest", "fastest", "most_reliable"])
          .default("balanced")
          .describe("Tie-breaking emphasis for the ranking weights."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe("How many ranked recommendations to return."),
        include_facilitator_context: z
          .boolean()
          .default(false)
          .describe(
            "If true, also return top facilitators by 7d settlement volume as separate ecosystem context (NOT per-service).",
          ),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      trackTool("x402_find_best_service", {
        category: args.category ?? null,
        network: args.network ?? null,
        prefer: args.prefer,
        require_verified: args.require_verified,
        has_query: Boolean(args.q),
        include_facilitator_context: args.include_facilitator_context,
      });
      try {
        // Network name/abbreviation -> canonical abbreviation. This is shared input normalization
        // (x402_search_services uses the same resolver), NOT ranking: the /best route validates the
        // abbreviation and returns 400 on an unknown one. An unrecognized input is forwarded raw so
        // the server is the single authority on the answer (decision 27/7: API-first).
        const net = args.network ? await resolveNetwork(args.network) : null;

        // Thin wrapper over GET /api/v1/best: the two-stage relevance->quality ranking now runs
        // server-side (identical scoring, locked byte-for-byte by the shared best.fixtures.json), and
        // the include_facilitator_context merge is server-side too (decision 27/7). The package holds
        // NO scoring logic. `require_verified`/`include_facilitator_context` are sent only when true
        // (false = no filter, the API default).
        const resp = await getBest({
          q: args.q,
          category: args.category,
          network: net?.abbrev,
          max_price_usd: args.max_price_usd,
          require_verified: args.require_verified ? true : undefined,
          prefer: args.prefer,
          limit: args.limit,
          include_facilitator_context: args.include_facilitator_context ? true : undefined,
        });

        // Surface the server's data block unchanged (recommendations shape is identical to what the
        // tool used to build client-side), lifting meta.ranking_version so a consumer can pin the
        // scoring generation. `note` is present only when nothing matched the filters.
        const d = resp.data;
        // B3: the scoring caveats live HERE, in the response, not in the tool description.
        // A caveat in the description is paid in context by every client that merely MOUNTS this
        // server; a caveat in `units` is paid only by the caller that actually ranked something.
        // Same mechanism x402_get_service already uses. Keep these two in sync with the API.
        const units: Record<string, string> = {
          ranking_version:
            "The scoring generation this answer was produced under, currently 3. Generation 2 introduced the compliance signability cap; generation 3 added the anti-wash traction rules below (the $10 volume floor, the single-buyer discount, whole-integer buyer counts). Scores you stored under an earlier generation are NOT comparable with these.",
          "recommendations[].score":
            "0 to 1 composite. Reliability (live status, verification, uptime, response time), x402 compliance and price carry the weight; measured on-chain traction carries a SMALL term of about 10% and can never dominate the other three.",
          compliance:
            "The share of deterministic x402 conformance checks the service passes, 0 to 1. CAPPED at 0.6, the floor of the C band, when at least one of its EVM routes was observed missing the EIP-712 domain parameters (extra.name and extra.version) that a standard x402 client needs in order to sign a payment. That is a fact about the payment envelope on the wire, not a judgement on the merit of the service.",
          traction:
            "Measured per service over its known payTo addresses via recognized settlers: a conservative undercount, never an estimate. The term is 0 with no on-chain settlement in the last 30 UTC days, and 0 when 30d volume is under a $10 floor (sub-floor volume is indistinguishable from dust and must not move rank). A service on a network not yet measured, or a shared-payout member whose probe has been failing, carries NO traction term at all and the remaining weights are RENORMALIZED over it, so an unmeasured service is not scored as if it had measured zero.",
          "traction.shared_payout":
            "When a payTo address is shared across services, only settlement VOLUME is attributed PRO-QUOTA: the operator-level volume over that address divided across the services sharing it, a declared convention rather than an individually observed measure. Transaction count and unique buyers stay WHOLE operator-level integers, never fractional. Sharing a payout therefore neither rewards a service nor lets clones multiply the same volume.",
          "recommendations[].top_buyer_share_30d":
            "0 to 1 share of the 30d settlement volume taken by the single largest buyer. A concentrated payout is DISCOUNTED, up to half the traction term when one buyer accounts for all of it: one buyer is one relationship, not broad demand.",
          need_blind_ranking:
            "true when no free-text q was supplied, so this order is global quality and NOT relevance to a need, whatever the ranking_basis prose asserts. A need-blind answer is not comparable with a q-driven one: they answer different questions.",
          facilitator_context:
            "Present only with include_facilitator_context=true: top facilitators by 7d settlement volume, as ECOSYSTEM context. It is per-facilitator, never per-service, and carries no meaning for any single recommendation.",
        };
        return ok({
          recommendations: d.recommendations,
          ranking_basis: d.ranking_basis,
          excluded_danger: d.excluded_danger,
          facilitator_context: d.facilitator_context,
          ...(d.note !== undefined ? { note: d.note } : {}),
          ranking_version: resp.meta?.ranking_version ?? null,
          // B-16#0: honest signal that no free-text need ('q') was supplied, so the ranking is
          // need-blind (global quality order), NOT relevance-matched to a need - regardless of what
          // ranking_basis prose asserts. True when q is absent/empty. A caller comparing this answer
          // against a q-driven one can see the two are not the same question.
          need_blind_ranking: !args.q,
          // Paid only by the caller that ranked: the full scoring caveats, out of the description.
          units,
        });
      } catch (e) {
        return fail(`x402_find_best_service failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.4 x402_check_health
  // -------------------------------------------------------------------------
  server.registerTool(
    "x402_check_health",
    {
      title: "Check x402 service health",
      description:
        "Call this before you send a payment, or right after a call unexpectedly failed: is this service up right now. With no slug, the directory snapshot: five status counts across 500+ services (include_services=true attaches every row). With a slug: that service's status, its 24h/7d/30d/90d uptime windows, response time, consecutive failures, daily snapshots. No money fields.",
      // B-14#1: STRICT object - an unknown top-level key is rejected (-32602), not silently dropped.
      inputSchema: z.object({
        slug: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Service slug for a single-service health report. Omit for the whole directory."),
        uptime_period: z
          .enum(["24h", "7d", "30d", "90d"])
          .default("30d")
          .describe("Daily uptime snapshot window for single-service mode."),
        // A-17#3: directory mode returns just the five status counts by default. The full per-service
        // list (453 rows, ~55k tokens, duplicated across content+structuredContent before the compact
        // mirror) is attached ONLY when include_services=true. Ignored in single-service mode.
        include_services: z
          .boolean()
          .default(false)
          .describe(
            "Directory mode only (no slug): if true, also attach the full per-service status array. Off by default so a directory health check returns just the five status counts, not every service.",
          ),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      trackTool("x402_check_health", {
        mode: args.slug ? "service" : "directory",
        slug: args.slug ? String(args.slug).slice(0, 128) : null,
        uptime_period: args.uptime_period,
        include_services: args.slug ? null : (args.include_services ?? false),
      });
      try {
        if (!args.slug) {
          const resp = await getStatus();
          const d = resp.data;
          const directory: Record<string, unknown> = {
            mode: "directory",
            summary: {
              total: d.total,
              online: d.online,
              degraded: d.degraded,
              offline: d.offline,
              unknown: d.unknown,
            },
          };
          // A-17#3: attach the full per-service list only on request (default: counts only).
          if (args.include_services) directory.services = d.services; // StatusServiceItem[] verbatim
          return ok(directory);
        }

        const detail = await getService(args.slug);
        const s = detail.data;
        let snapshots: unknown[] = [];
        let snapshotsError: string | undefined;
        try {
          const up = await getServiceUptime(args.slug, args.uptime_period);
          snapshots = up.data;
        } catch (e) {
          snapshotsError = describeError(e);
        }
        const result: Record<string, unknown> = {
          mode: "service",
          slug: s.slug,
          name: s.name,
          status: s.status,
          uptime: s.uptime,
          avg_response_time_ms: s.avg_response_time_ms,
          total_checks: s.total_checks,
          consecutive_failures: s.consecutive_failures,
          last_checked_at: s.last_checked_at,
          snapshots,
        };
        if (snapshotsError) result.snapshots_error = snapshotsError;
        return ok(result);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          return fail(`Service '${args.slug}' not found.`);
        }
        return fail(`x402_check_health failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.5 x402_facilitator_volumes (the core per-facilitator on-chain metric)
  // -------------------------------------------------------------------------
  server.registerTool(
    "x402_facilitator_volumes",
    {
      title: "x402 facilitator volumes",
      description:
        "Call this when the question is about the rail rather than the service: which x402 facilitator actually settles money, and how much. Returns on-chain-verified settlement volume and transaction counts per facilitator for today (UTC), 7d, 30d and all-time, plus a verification flag ('on-chain' once volume has been observed on-chain, else 'listed'), across more than 30 facilitators. Optional daily timeseries (up to 90 days) and per-chain breakdown. Volume is decimal USD. Caveats: PER-FACILITATOR, never per-service; the *_24h fields cover today (UTC) so far, not a trailing 24 hours, and reset at 00:00 UTC, so prefer 7d.",
      // B-14#1: STRICT object - an unknown top-level key is rejected (-32602), not silently dropped.
      inputSchema: z.object({
        timeframe: z
          .enum(["24h", "7d", "30d", "all"])
          .default("7d")
          .describe(
            "Drives the sort order of the returned facilitators. '24h' sorts by today (UTC) so far, not by a trailing 24-hour window.",
          ),
        include_timeseries: z
          .boolean()
          .default(false)
          .describe("Include a daily volume_usd / tx_count series per facilitator."),
        include_chains: z
          .boolean()
          .default(false)
          .describe("Include a per-chain (network/asset) volume breakdown per facilitator."),
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(30)
          .describe("Length of the timeseries in days (only used when include_timeseries is true)."),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(25),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      trackTool("x402_facilitator_volumes", {
        timeframe: args.timeframe,
        include_timeseries: args.include_timeseries,
        include_chains: args.include_chains,
      });
      try {
        const includes = [
          args.include_timeseries && "timeseries",
          args.include_chains && "chains",
        ]
          .filter(Boolean)
          .join(",");
        const resp = await getFacilitators({
          timeframe: args.timeframe,
          include: includes || undefined,
          days: args.days,
          page: args.page,
          per_page: args.per_page,
        });
        return ok({
          facilitators: resp.data, // Facilitator[] verbatim, USD passed through
          meta: resp.meta,
          units: {
            "volume_usd_24h/7d/30d/all": "decimal US dollars; the *_24h fields cover today (UTC) so far, not a trailing 24-hour window, and reset at 00:00 UTC",
            "tx_count_*": "integer transaction counts",
            verification: "'on-chain' iff observed on-chain volume > 0, else 'listed'",
          },
        });
      } catch (e) {
        return fail(`x402_facilitator_volumes failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.6 x402_assess_services (PAID pass-through; the package holds NO keys and NEVER signs/settles)
  // -------------------------------------------------------------------------
  server.registerTool(
    "x402_assess_services",
    {
      title: "Assess x402 services (paid)",
      description:
        "Call this when the free signals have run out: you hold 2 to 8 finalists from x402_search_services or x402_find_best_service, their stored fields do not separate them for YOUR stated need, and choosing wrong costs more than a quarter. It buys one fresh AI assessment reasoned against your question, not a cached grade; reading an already-computed assessment stays free via x402_get_service. Price: a one-time $0.25 USDC on Base, over two calls. Call once WITHOUT payment_signature_b64 to receive the x402 payment challenge verbatim (accepts[], amount, payTo, and a base64 PAYMENT-REQUIRED header); sign accepts[0] client-side with your own wallet; call again with the SAME question and services plus payment_signature_b64 to receive the report and a base64 PAYMENT-RESPONSE settlement receipt. This server holds no keys, never signs and never settles: it only relays the challenge. Optionally add probe { slug, endpoint_path? } to have one listed service paid and called for real and its answer analyzed: the challenge is then priced at $0.25 plus that endpoint price X, and the report gains a probe_report block with a verdict and truncated extracts, never the verbatim third-party body. When live probing is not armed the probe is ignored. Caveats: read the amount to sign from accepts[0].amount, never from a fixed figure, since a probe changes it; probe fees are non-refundable whatever the verdict; if the fresh run cannot be produced the server answers before settling, so you are never charged for nothing; there is no refund. Prices are US dollars.",
      // B-14#1: STRICT object - an unknown top-level key is rejected (-32602), not silently dropped.
      // Matters most on a PAID tool: a misnamed key can no longer change what is charged for.
      inputSchema: z.object({
        question: z
          .string()
          .trim()
          .min(1)
          .max(1000)
          .describe("The need to assess the shortlist against (1 to 1000 characters)."),
        services: z
          .array(z.string().trim().min(1).max(200))
          .min(1)
          .max(8)
          .describe(
            "Service slugs to compare for the need (1 to 8; find them with x402_search_services or x402_find_best_service).",
          ),
        payment_signature_b64: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Base64 PAYMENT-SIGNATURE for the x402 payment, produced by signing the accepts[0] challenge client-side. Omit on the first call to receive the challenge; set it on the retry to run the paid assessment.",
          ),
        // Optional live-probe target (treno 4). Pure pass-through: forwarded verbatim to the server,
        // which ignores it unless live probing is armed and prices the challenge $0.25 + the endpoint
        // price X. The package holds no keys and never signs the extra X.
        probe: z
          .object({
            slug: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .describe("Slug of one listed service to probe live (must be one of the services above or another listed slug)."),
            endpoint_path: z
              .string()
              .trim()
              .min(1)
              .max(500)
              .optional()
              .describe("Optional URL path on that service to probe, beginning with '/'. Omit to let the server pick the cheapest priced USDC-on-Base endpoint."),
          })
          .optional()
          .describe(
            "Optional live-probe request: pay one listed service for real and analyze what it returns. When the server has probing armed the price becomes $0.25 plus that endpoint price X (non-refundable); the report gains a probe_report block with a verdict and truncated extracts, never the verbatim third-party body. Ignored when probing is not armed.",
          ),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      trackTool("x402_assess_services", {
        service_count: args.services.length,
        has_signature: Boolean(args.payment_signature_b64),
        has_probe: Boolean(args.probe),
      });
      try {
        const result = await postAssess(
          // probe is forwarded verbatim (undefined drops out of the JSON body); the server is the
          // single authority on whether it is offered and how the challenge is priced.
          { question: args.question, services: args.services, probe: args.probe },
          args.payment_signature_b64,
        );
        if (result.status === 200) {
          // Paid: return the modular report ({data, meta, provenance}) plus the settle receipt.
          const body = (result.body ?? {}) as Record<string, unknown>;
          return ok({
            status: 200,
            data: body.data ?? null,
            meta: body.meta ?? null,
            provenance: body.provenance ?? null,
            payment_response_b64: result.paymentResponseHeaderB64,
          });
        }
        if (result.status === 402) {
          // Return the PaymentRequired challenge VERBATIM (accepts/amount/payTo + the base64 header).
          // The package does not sign: the caller signs client-side and retries with the signature.
          return ok({
            status: 402,
            payment_required: result.body,
            payment_required_header_b64: result.paymentRequiredHeaderB64,
            instruction: buildAssessInstruction(result.body),
            ...(args.payment_signature_b64 ? { note: ASSESS_SIGNATURE_REJECTED_NOTE } : {}),
          });
        }
        // 400 (validation), 503 (dark or an uncharged fail-soft miss), or anything else: surface the
        // server's message as a tool error.
        const msg = extractApiMessage(result.body) ?? `x402_assess_services failed: HTTP ${result.status}`;
        return fail(msg);
      } catch (e) {
        return fail(`x402_assess_services failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.7 x402_change_events (T1a drift feed; read-only, free)
  //
  // WIRE-NAME TRAP: the per-service filter is `service`, NOT `slug`. The API ignores an unknown
  // query param rather than rejecting it, so a `slug=` would return the whole unfiltered feed and
  // be reported here as filtered. Pinned by a test in tools.test.ts.
  // NO USD ANYWHERE: the prices in this feed (summary.priceChanges[].oldPrice/newPrice and the
  // `price` inside the snapshots) are ATOMIC token amounts, never dollars. Passed through verbatim
  // per the USD PASS-THROUGH rule at the top of this file: no rescale, no conversion.
  // -------------------------------------------------------------------------
  server.registerTool(
    "x402_change_events",
    {
      title: "x402 service change events",
      description:
        "Call this before you trust anything you cached about a service, and right after a payment failed for no obvious reason: the monitor's log of what moved under you. Returns payTo, price and 402-schema changes observed on listed services, most recent first, in exactly three event types (payto_changed, price_changed, schema_changed). Filter with service (the slug), type, and days (1 to 365, default 90). Caveats: prices here are atomic token amounts, never dollars, and every payTo is masked by design, so the feed reports THAT the payout address changed, never the address. Free and read-only.",
      // STRICT object, like every other tool: an unknown top-level key is rejected with -32602
      // instead of being dropped and the query answered as if the filter had been honored.
      inputSchema: z.object({
        service: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Service slug to restrict the feed to, e.g. 'exa' (the same slug x402_get_service takes). Omit for changes across every listed service.",
          ),
        type: z
          .enum(["payto_changed", "price_changed", "schema_changed"])
          .optional()
          .describe(
            "Restrict to one kind of change: 'payto_changed' (the payout address set changed), 'price_changed' (at least one endpoint's price changed), 'schema_changed' (the 402 envelope gained or lost accepts entries or priced endpoints). Omit for all three.",
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .default(90)
          .describe(
            "Lookback window in days, 1 to 365 (default 90). Events older than the window are not in the feed.",
          ),
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("1-based page index into the filtered event set (see total_pages)."),
        per_page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe(
            "Events per page, 1 to 100 (default 25). Each event carries the full before/after envelope snapshots, so a large page is heavy.",
          ),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      trackTool("x402_change_events", {
        service: args.service ? String(args.service).slice(0, 128) : null,
        type: args.type ?? null,
        days: args.days ?? null,
        page: args.page ?? null,
        per_page: args.per_page ?? null,
      });
      try {
        const resp = await getChanges({
          // `service` is the wire name. Do NOT rename this to `slug`: the API would ignore it and
          // answer with the whole unfiltered feed, silently.
          service: args.service,
          type: args.type,
          days: args.days,
          page: args.page,
          per_page: args.per_page,
        });
        return ok({
          changes: resp.data, // ChangeEvent[] verbatim, summaries and snapshots untouched
          // Explicitly the SERVER's total for the filtered window, not this page's length. The two
          // differ by design (a filtered feed can hold thousands of events across many pages), so
          // `returned` carries the page length separately and neither is ever inferred from the other.
          total: resp.meta.total,
          returned: resp.data.length,
          page: resp.meta.page,
          per_page: resp.meta.per_page,
          total_pages: resp.meta.total_pages,
          days: resp.meta.days,
          filters_applied: {
            service: args.service ?? null,
            type: args.type ?? null,
          },
          units: {
            observed_at:
              "ISO 8601 UTC timestamp of when the monitor observed the change, not when the operator made it. Events are returned most recent first; the order is fixed and cannot be configured.",
            type: "'payto_changed' = the set of payout addresses the service asks to be paid at changed (one added, one dropped, or both); 'price_changed' = at least one endpoint changed price; 'schema_changed' = the 402 envelope itself changed, with accepts entries or priced endpoints added or removed. Every event is exactly one of these three.",
            summary:
              "Per-type diff digest, passed through verbatim: payto_changed carries payToAdded/payToRemoved, price_changed carries priceChanges[{network, endpoint, oldPrice, newPrice, assetName}], schema_changed carries schemaAdded/schemaRemoved/endpointsAdded/endpointsRemoved.",
            "summary.priceChanges[].oldPrice/newPrice":
              "ATOMIC on-chain token units (uint256 strings) in that route's own asset, NOT dollars. Do not rescale them and do not read them as USD; a change of asset can move the number without moving the real price.",
            "old_snapshot/new_snapshot":
              "The service's full accepts array before and after the change, verbatim. The `price` field inside is an ATOMIC token amount too, not dollars.",
            payTo:
              "Every payTo address in this feed is MASKED by the API (leading and trailing characters only), deliberately: the feed reports THAT the payout address changed, never the address in full. Do not present a masked value as a full address and do not try to reconstruct one.",
            total:
              "The server's count of events matching the filter over the whole window, NOT the number of events on this page. `returned` is the page length; page through with page/per_page up to total_pages.",
            days: "The lookback window actually applied, in days; the server clamps the request to 1 to 365 (default 90).",
          },
        });
      } catch (e) {
        // zod blocks an out-of-set `type` before the wire, so this 400 branch should be
        // unreachable; keep it so an API-side validation change surfaces as a readable message
        // instead of a bare HTTP status.
        if (e instanceof ApiError && e.status === 400) {
          return fail(`x402_change_events: the API rejected the query: ${describeError(e)}`);
        }
        return fail(`x402_change_events failed: ${describeError(e)}`);
      }
    },
  );
}
