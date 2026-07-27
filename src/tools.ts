// The 6 x402-list MCP tools: schemas, handlers, response mapping.
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
let networkMapPromise: Promise<Map<string, string>> | null = null;
function getNetworkMap(): Promise<Map<string, string>> {
  if (!networkMapPromise) {
    networkMapPromise = (async () => {
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
      } catch {
        // Networks endpoint unreachable: leave the map empty. resolveNetwork then
        // treats the input as a raw abbreviation, which still works for "BSE"-style
        // input and correctly filters to nothing for an unknown value.
      }
      return m;
    })();
  }
  return networkMapPromise;
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
  return {
    structuredContent: structured as Record<string, unknown>,
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
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

// Pull a human message out of an API error/control body ({error:{code,message}}, {error, message},
// or {message}). Used by assess_services to surface a 400/503 answer to the agent.
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

// ── assess_services copy (user-facing; census in docs/COPY-REVIEW-t1c-t2.md) ──
const ASSESS_PAYMENT_INSTRUCTION =
  "Payment required. Sign the single accepts[0] option ($0.25 USDC on Base) client-side with your own x402-capable wallet, then call assess_services again with the same question and services and set payment_signature_b64 to the base64 PAYMENT-SIGNATURE you produced. This server never holds keys and never signs: it only relays the challenge. There is no refund.";
const ASSESS_SIGNATURE_REJECTED_NOTE =
  "A payment_signature_b64 was supplied but the server did not settle (the signature did not verify, funds were insufficient, or the quoted price changed). Re-sign the accepts[0] option in this fresh challenge and retry.";

export function registerTools(server: McpServer): void {
  // -------------------------------------------------------------------------
  // 3.1 search_x402_services
  // -------------------------------------------------------------------------
  server.registerTool(
    "search_x402_services",
    {
      description:
        "Search and filter the x402-list directory of services that accept x402 payments. Filter by free-text query, category, network, and live status; sort by newest, uptime, cheapest, or endpoint count. Returns service summaries with price (USD), uptime, status, and verification. Prices are in US dollars.",
      inputSchema: {
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
        sort: z
          .enum(["newest", "uptime", "cheapest", "endpoints"])
          .default("newest")
          .describe("Server-side sort order."),
        page: z.number().int().min(1).default(1),
        per_page: z.number().int().min(1).max(100).default(25),
      },
    },
    async (args) => {
      trackTool("search_x402_services", {
        category: args.category ?? null,
        network: args.network ?? null,
        status: args.status,
        sort: args.sort,
        verified_only: args.verified_only,
        has_query: Boolean(args.q),
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
        });
        let services: ServiceListItem[] = resp.data;
        // Re-assert the network filter client-side: the API silently ignores an
        // unknown value, so never let an unfiltered list pass as filtered.
        if (net) services = services.filter((s) => s.networks.includes(net.abbrev));
        const notes = ["min_price_usd values are decimal US dollars."];
        if (net && !net.recognized) {
          notes.push(
            `network '${args.network}' did not match any known network (${await knownNetworksHint()}); no services match it.`,
          );
        }
        return ok({
          services, // fields verbatim, min_price_usd in decimal USD
          meta: resp.meta,
          returned: services.length,
          filters_applied: {
            q: args.q ?? null,
            category: args.category ?? null,
            network: net ? net.abbrev : null,
            network_recognized: net ? net.recognized : null,
            status: args.status,
            sort: args.sort,
            verified_only: args.verified_only,
          },
          note: notes.join(" "),
        });
      } catch (e) {
        return fail(`search_x402_services failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.2 get_service
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_service",
    {
      description:
        "Get full detail for one x402 service by slug: live status, uptime over 24h/7d/30d/90d, average response time, accepted networks and settlement asset, and every priced endpoint with its USD price. Use after search_x402_services to inspect a specific service. Prices are in US dollars; the per-endpoint `price` field is a raw on-chain atomic token amount, not dollars.",
      inputSchema: {
        slug: z.string().trim().min(1).max(200).describe("Service slug, e.g. 'my-api'."),
        include_series: z
          .boolean()
          .default(false)
          .describe(
            "If true, also attach this service's daily on-chain series under `series` (settlement volume and distinct buyers, one point per UTC day over the most recent 90 days, oldest first). Off by default to keep the response small.",
          ),
      },
    },
    async (args) => {
      trackTool("get_service", {
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
            "Fase 2 (family 6): on-chain settlement traction measured over this service's known payTo addresses via recognized settlers. All *_usd/count fields are a CONSERVATIVE UNDERCOUNT (unattributed settlements are not counted, never estimated up). volume_usd_30d = decimal USD over the last 30 UTC days; tx_count_30d/unique_buyers_30d = counts over 30d; last_settlement_at = ISO 8601 of the most recent settlement; top_buyer_share_30d = 0-1 concentration of the largest buyer; trend_7d_vs_30d = last-7d daily rate over the 30d daily rate; measured_networks = canonical CAIP-2 chains that contributed. status: 'measured' = real numbers where 0 is an HONEST zero; 'no-payto'/'unmeasured-network' = null, never a fake zero; 'unresponsive' = a shared-payout member whose probe has been failing for 7 days, so its share is suppressed (null). shared_payout=true means the payTo is shared across N services; volume_usd_30d, tx_count_30d and unique_buyers_30d are then attributed PRO-QUOTA (the operator-level figure divided by the N current members) - a declared convention, not an individually observed measure. The ratios top_buyer_share_30d and trend_7d_vs_30d are left whole (invariant under the division). unique_buyers_30d can therefore be fractional. Beyond the 30d figures the traction block carries `first_settlement_at`, all-time `volume_usd_all_time` / `tx_count_all_time` (pro-quota on a shared payout, like the 30d figures), the per-settlement `median_settlement_usd_30d` / `max_settlement_usd_30d` (invariant amounts, never divided), the `settled_via` facilitator list (volume first), and `shared_with_services` (the sibling listed services on a shared payout address).",
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
        return fail(`get_service failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.3 find_best_service (reliability/compliance/price primary; on-chain traction weighs ~10%,
  //     shared-payout traction is attributed pro-quota; unmeasured/suppressed carry no term)
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_best_service",
    {
      description:
        "Recommend the best x402 service(s) for a need. Ranked mostly on per-service reliability (live status, verification, uptime, response time), x402 compliance, and price (USD), filtered by category and network, with a SMALL (~10%) weight on on-chain traction: settlement volume, transaction count, and unique buyers measured per service over its known payTo addresses via recognized settlers (a conservative undercount, not an estimate). Traction never dominates; a service whose payTo is shared across services has its traction attributed PRO-QUOTA (volume and buyers divided by the number of services sharing the payout), so sharing neither rewards nor spam-clones a service. A service on a network not yet measured, or a shared member whose probe has been failing, carries no traction term (the other weights are renormalized). Traction also requires recent settlement: with no on-chain settlement in the last 30 UTC days the term is 0. Each recommendation also reports top_buyer_share_30d, the 30d volume share of the single largest buyer, as a published concentration signal for the reader; it does not enter the score. Optionally attach ecosystem facilitator-volume context separately.",
      inputSchema: {
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
      },
    },
    async (args) => {
      trackTool("find_best_service", {
        category: args.category ?? null,
        network: args.network ?? null,
        prefer: args.prefer,
        require_verified: args.require_verified,
        has_query: Boolean(args.q),
        include_facilitator_context: args.include_facilitator_context,
      });
      try {
        // Network name/abbreviation -> canonical abbreviation. This is shared input normalization
        // (search_x402_services uses the same resolver), NOT ranking: the /best route validates the
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
        return ok({
          recommendations: d.recommendations,
          ranking_basis: d.ranking_basis,
          excluded_danger: d.excluded_danger,
          facilitator_context: d.facilitator_context,
          ...(d.note !== undefined ? { note: d.note } : {}),
          ranking_version: resp.meta?.ranking_version ?? null,
        });
      } catch (e) {
        return fail(`find_best_service failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.4 check_health
  // -------------------------------------------------------------------------
  server.registerTool(
    "check_health",
    {
      description:
        "Check live health of x402 services. With no slug, returns a directory-wide snapshot (counts of online/degraded/offline/unknown plus per-service status). With a slug, returns that service's status, uptime windows, response time, consecutive failures, and recent daily uptime snapshots. No money fields.",
      inputSchema: {
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
      },
    },
    async (args) => {
      trackTool("check_health", {
        mode: args.slug ? "service" : "directory",
        slug: args.slug ? String(args.slug).slice(0, 128) : null,
        uptime_period: args.uptime_period,
      });
      try {
        if (!args.slug) {
          const resp = await getStatus();
          const d = resp.data;
          return ok({
            mode: "directory",
            summary: {
              total: d.total,
              online: d.online,
              degraded: d.degraded,
              offline: d.offline,
              unknown: d.unknown,
            },
            services: d.services, // StatusServiceItem[] verbatim
          });
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
        return fail(`check_health failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.5 get_facilitator_volumes (the core per-facilitator on-chain metric)
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_facilitator_volumes",
    {
      description:
        "Get on-chain-verified settlement volume per x402 facilitator (the core x402-list metric). Returns USD settlement volume and transaction counts for today (UTC)/7d/30d/all-time, plus a `verification` flag ('on-chain' when volume has been observed on-chain, else 'listed'). Note: the fields named *_24h cover today (UTC) so far, not a trailing 24-hour window, so they reset at 00:00 UTC and read near zero just after midnight; prefer 7d for a stable recent-activity read. Optionally include a daily timeseries and per-chain breakdown. All volume figures are in US dollars. This is PER-FACILITATOR, not per-service.",
      inputSchema: {
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
      },
    },
    async (args) => {
      trackTool("get_facilitator_volumes", {
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
            "volume_usd_24h/7d/30d/all": "decimal US dollars",
            "tx_count_*": "integer transaction counts",
            verification: "'on-chain' iff observed on-chain volume > 0, else 'listed'",
          },
        });
      } catch (e) {
        return fail(`get_facilitator_volumes failed: ${describeError(e)}`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // 3.6 assess_services (PAID pass-through; the package holds NO keys and NEVER signs/settles)
  // -------------------------------------------------------------------------
  server.registerTool(
    "assess_services",
    {
      description:
        "Run a fresh, PAID AI assessment comparing a shortlist of already-listed x402 services for a stated need. It charges a one-time $0.25 USDC on Base (x402) for the fresh reasoning only; reading an already-computed assessment stays free via get_service. This tool is a pure pass-through: it never holds keys, never signs, and never settles. Call it once WITHOUT payment_signature_b64 to receive the x402 payment challenge (accepts[], amount, payTo, and a base64 PAYMENT-REQUIRED header) verbatim; sign accepts[0] client-side with your own wallet; then call again with the SAME question and services plus payment_signature_b64 to receive the assessment report and a base64 PAYMENT-RESPONSE settlement receipt. If the fresh run cannot be produced the server answers before settling, so the caller is never charged, and there is no refund. Prices are US dollars.",
      inputSchema: {
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
            "Service slugs to compare for the need (1 to 8; find them with search_x402_services or find_best_service).",
          ),
        payment_signature_b64: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Base64 PAYMENT-SIGNATURE for the x402 payment, produced by signing the accepts[0] challenge client-side. Omit on the first call to receive the challenge; set it on the retry to run the paid assessment.",
          ),
      },
    },
    async (args) => {
      trackTool("assess_services", {
        service_count: args.services.length,
        has_signature: Boolean(args.payment_signature_b64),
      });
      try {
        const result = await postAssess(
          { question: args.question, services: args.services },
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
            instruction: ASSESS_PAYMENT_INSTRUCTION,
            ...(args.payment_signature_b64 ? { note: ASSESS_SIGNATURE_REJECTED_NOTE } : {}),
          });
        }
        // 400 (validation), 503 (dark or an uncharged fail-soft miss), or anything else: surface the
        // server's message as a tool error.
        const msg = extractApiMessage(result.body) ?? `assess_services failed: HTTP ${result.status}`;
        return fail(msg);
      } catch (e) {
        return fail(`assess_services failed: ${describeError(e)}`);
      }
    },
  );
}
