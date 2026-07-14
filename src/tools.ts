// The 5 x402-list MCP tools: schemas, handlers, response mapping.
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
  getFacilitators,
  getStatus,
  getNetworks,
  type ServiceListItem,
  type ServiceTraction,
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
            "If true, return only verified services (filtered client-side; API has no verified query param).",
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
        });
        let services: ServiceListItem[] = resp.data;
        // Re-assert the network filter client-side: the API silently ignores an
        // unknown value, so never let an unfiltered list pass as filtered.
        if (net) services = services.filter((s) => s.networks.includes(net.abbrev));
        if (args.verified_only) services = services.filter((s) => s.verified === true);
        const notes = [
          "min_price_usd values are decimal US dollars.",
          "verified_only filters the current page only.",
        ];
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
      },
    },
    async (args) => {
      trackTool("get_service", { slug: String(args.slug).slice(0, 128) });
      try {
        const resp = await getService(args.slug);
        return ok({
          service: resp.data, // full ServiceDetail verbatim (includes `assessment` when present)
          units: {
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
              "Fase 2 (family 6): on-chain settlement traction measured over this service's known payTo addresses via recognized settlers. All *_usd/count fields are a CONSERVATIVE UNDERCOUNT (unattributed settlements are not counted, never estimated up). volume_usd_30d = decimal USD over the last 30 UTC days; tx_count_30d/unique_buyers_30d = counts over 30d; last_settlement_at = ISO 8601 of the most recent settlement; top_buyer_share_30d = 0-1 concentration of the largest buyer; trend_7d_vs_30d = last-7d daily rate over the 30d daily rate; measured_networks = canonical CAIP-2 chains that contributed. status: 'measured' = real numbers where 0 is an HONEST zero; 'no-payto'/'unmeasured-network' = null, never a fake zero. shared_payout=true means the payTo is shared across services, so the volume is the OPERATOR's and is NOT split per service (do not read it as this service's revenue).",
          },
        });
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
  //     shared-payout and unmeasured-network services carry a neutral traction term)
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_best_service",
    {
      description:
        "Recommend the best x402 service(s) for a need. Ranked mostly on per-service reliability (live status, verification, uptime, response time), x402 compliance, and price (USD), filtered by category and network, with a SMALL (~10%) weight on on-chain traction: settlement volume, transaction count, and unique buyers measured per service over its known payTo addresses via recognized settlers (a conservative undercount, not an estimate). Traction never dominates; a service whose payTo is shared across services (operator-level volume), or that sits on a network not yet measured, carries a NEUTRAL traction term (never rewarded or penalized, weights renormalized). Each recommendation also reports top_buyer_share_30d, the 30d volume share of the single largest buyer, as a published concentration signal for the reader; it does not enter the score. Optionally attach ecosystem facilitator-volume context separately.",
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
        const net = args.network ? await resolveNetwork(args.network) : null;
        const queryTokens = tokenize(args.q ?? "");
        const hasQuery = queryTokens.length > 0;

        // Build a candidate pool for a given server-side text query, deduped by slug and
        // (optionally) widened past the online-only set. `wide` pages through the WHOLE
        // catalogue (every status, following the API's meta.total_pages up to a small cap)
        // so relevance ranking sees tag-only and offline matches too; a single page-1 pull
        // silently dropped services once the directory grew past one page. Otherwise it keeps
        // the original online-first pool and only widens when too thin for `limit`.
        const WIDE_PAGE_CAP = 5; // per_page 100 => up to 500 services, covers the full catalogue with headroom
        const buildPool = async (
          serverQ: string | undefined,
          wide: boolean,
        ): Promise<ServiceListItem[]> => {
          const bySlug = new Map<string, ServiceListItem>();
          if (wide) {
            const first = await getServices({
              q: serverQ,
              category: args.category,
              network: net?.abbrev,
              status: undefined,
              sort: "uptime",
              per_page: 100,
              page: 1,
            });
            for (const s of first.data) bySlug.set(s.slug, s);
            const totalPages = Math.min(first.meta?.total_pages ?? 1, WIDE_PAGE_CAP);
            for (let page = 2; page <= totalPages; page++) {
              const next = await getServices({
                q: serverQ,
                category: args.category,
                network: net?.abbrev,
                status: undefined,
                sort: "uptime",
                per_page: 100,
                page,
              });
              for (const s of next.data) if (!bySlug.has(s.slug)) bySlug.set(s.slug, s);
            }
            return [...bySlug.values()];
          }
          const first = await getServices({
            q: serverQ,
            category: args.category,
            network: net?.abbrev,
            status: "online",
            sort: "uptime",
            per_page: 100,
            page: 1,
          });
          for (const s of first.data) bySlug.set(s.slug, s);
          if (bySlug.size < args.limit) {
            const widen = await getServices({
              q: serverQ,
              category: args.category,
              network: net?.abbrev,
              status: undefined,
              sort: "uptime",
              per_page: 100,
              page: 1,
            });
            for (const s of widen.data) if (!bySlug.has(s.slug)) bySlug.set(s.slug, s);
          }
          return [...bySlug.values()];
        };

        // Hard filters, re-asserted client-side (the API silently ignores an unknown network).
        const applyHardFilters = (list: ServiceListItem[]): ServiceListItem[] => {
          let p = list;
          if (net) p = p.filter((s) => s.networks.includes(net.abbrev));
          if (args.category) p = p.filter((s) => s.category === args.category);
          if (args.max_price_usd !== undefined) {
            p = p.filter((s) => s.min_price_usd !== null && s.min_price_usd <= args.max_price_usd!);
          }
          if (args.require_verified) p = p.filter((s) => s.verified === true);
          return p;
        };
        // Family 8 (risk): a DETERMINISTIC danger flag removes a service from a "recommend
        // the best" surface entirely. A residual warning stays but is penalized in the
        // quality score below. danger is never inferred from an LLM, low uptime, or a high
        // price - only an exact blocklist/impersonation match.
        const dropDanger = (list: ServiceListItem[]) => ({
          kept: list.filter((s) => s.assessment?.risk_level !== "danger"),
          excluded: list.filter((s) => s.assessment?.risk_level === "danger").map((s) => s.slug),
        });

        // 1. Candidate pool. With a free-text need we do NOT push `q` to the server: its
        // ILIKE only spans name/description/category/base_url and cannot see the AI-derived
        // capability tags/summary, so a service matching only via tags would never enter the
        // pool. We pull the catalogue and rank by relevance below (stage 1). Without a need
        // the original online-first server pool is used directly.
        let filtered = dropDanger(applyHardFilters(await buildPool(undefined, hasQuery)));
        let pool = filtered.kept;
        let excludedDanger = filtered.excluded;

        // Relevance floor + substring-`q` fallback (only with a free-text need). Keep only
        // candidates with at least one grounded token hit (measured text OR a confidence-
        // weighted capability tag). If that leaves nothing, fall back to the server's
        // substring-`q` pool so a base_url or phrase match the tokenizer misses is not lost.
        if (hasQuery) {
          const relevant = pool.filter((s) => relevanceScore(s, queryTokens) > 0);
          if (relevant.length > 0) {
            pool = relevant;
          } else {
            filtered = dropDanger(applyHardFilters(await buildPool(args.q, false)));
            pool = filtered.kept;
            excludedDanger = filtered.excluded;
          }
        }

        const facilitatorContext = args.include_facilitator_context
          ? await topFacilitatorContext()
          : null;

        const rankingBasis =
          "Two stages. (1) RELEVANCE: when a free-text need is given, each candidate is scored on how well your query matches its AI-derived capability tags and summary plus its name/description/category (falls back to plain text match). (2) QUALITY: measured families combined with explicit weights - reliability (live status, uptime, response time), x402 compliance grade, economics (price and in-category price percentile), safety risk, and a SMALL ~10% weight on on-chain traction (per-service settlement volume, transaction count and unique buyers, measured over the service's known payTo via recognized settlers as a conservative undercount). Traction never dominates; a service with a shared payTo or on an unmeasured network carries a neutral traction term (the other weights are renormalized, so it is neither rewarded nor penalized). Each recommendation also carries top_buyer_share_30d (0-1, the 30d volume share of the largest single buyer) as a published concentration signal for the reader only; it is not part of the score. AI-derived fields are labeled {value,confidence,source:'ai'} and NEVER override a measured value.";

        if (pool.length === 0) {
          return ok({
            recommendations: [],
            ranking_basis: rankingBasis,
            note:
              net && !net.recognized
                ? `network '${args.network}' did not match any known network (${await knownNetworksHint()}); no services match it`
                : "no services match the hard filters",
            excluded_danger: excludedDanger,
            facilitator_context: facilitatorContext,
          });
        }

        // ── Stage 1: relevance (only when a free-text need is given) ──────────────
        // The pool was gathered WITHOUT the server `q` (so tag-only matches survive); this
        // ranks it using the already-computed synthesis capability tags + summary plus the
        // measured text. No live LLM here (the model key is server-only). A candidate is
        // never hidden for being unclassifiable.
        const relevanceOf = (s: ServiceListItem) =>
          queryTokens.length === 0 ? 1 : relevanceScore(s, queryTokens);

        // ── Stage 2: measured quality sub-scores, anchored to families 1,2,5,8 ────
        // Family 1 (reliability): status + uptime + response speed. Prefer the assessed
        // 30d uptime / p95 response when present, else the list's 24h uptime / avg response.
        const statusScore = (s: ServiceListItem) =>
          ({ online: 1.0, degraded: 0.5, unknown: 0.25, offline: 0.0 }[s.status]);
        const uptimeOf = (s: ServiceListItem) => s.assessment?.reliability_uptime_30d ?? s.uptime_24h;
        const uptimeScore = (s: ServiceListItem) => (uptimeOf(s) ?? 0) / 100;
        const speedOf = (s: ServiceListItem) => s.assessment?.response_p95_ms ?? s.avg_response_time_ms;
        const rtVals = pool.map(speedOf).filter((v): v is number => v !== null && v !== undefined);
        const rtMin = rtVals.length ? Math.min(...rtVals) : 0;
        const rtMax = rtVals.length ? Math.max(...rtVals) : 1;
        const speedScore = (s: ServiceListItem) => {
          const v = speedOf(s);
          return v === null || v === undefined ? 0.5 : rtMax === rtMin ? 1.0 : 1 - (v - rtMin) / (rtMax - rtMin);
        };
        // Internal reliability composition, tilted by `prefer` (explicit weights).
        const relWeights = {
          balanced: { status: 0.4, uptime: 0.4, speed: 0.2 },
          most_reliable: { status: 0.4, uptime: 0.5, speed: 0.1 },
          cheapest: { status: 0.4, uptime: 0.4, speed: 0.2 },
          fastest: { status: 0.2, uptime: 0.3, speed: 0.5 },
        }[args.prefer];
        const reliabilityScore = (s: ServiceListItem) =>
          relWeights.status * statusScore(s) + relWeights.uptime * uptimeScore(s) + relWeights.speed * speedScore(s);

        // Family 2 (compliance): x402 conformance grade; verified is a weak fallback when unassessed.
        const complianceScore = (s: ServiceListItem) =>
          s.assessment?.compliance_grade ? gradeScore(s.assessment.compliance_grade) : s.verified ? 0.6 : 0.4;

        // Family 5 (economics): cheaper price + lower in-category price percentile = better.
        const priceOf = (s: ServiceListItem) => s.assessment?.price_usd ?? s.min_price_usd;
        const pVals = pool.map(priceOf).filter((v): v is number => v !== null && v !== undefined);
        const pMin = pVals.length ? Math.min(...pVals) : 0;
        const pMax = pVals.length ? Math.max(...pVals) : 1;
        const priceNorm = (s: ServiceListItem) => {
          const v = priceOf(s);
          return v === null || v === undefined ? 0.5 : pMax === pMin ? 1.0 : 1 - (v - pMin) / (pMax - pMin);
        };
        const economicsScore = (s: ServiceListItem) => {
          const pct = s.assessment?.category_percentile;
          const pctScore = typeof pct === "number" ? 1 - pct / 100 : null;
          return pctScore === null ? priceNorm(s) : 0.6 * priceNorm(s) + 0.4 * pctScore;
        };

        // Family 8 (risk): a residual warning is penalized (danger already excluded above).
        const riskScore = (s: ServiceListItem) => (s.assessment?.risk_level === "warning" ? 0.4 : 1.0);

        // Family 6 (on-chain traction, Fase 2): a SMALL, bounded quality term. Derived ONLY from
        // measured fields and applied with weight TRACTION_WEIGHT so it can never dominate the four
        // assessment families. Per D5 the term is NEUTRAL - excluded, with the four family weights
        // (which already sum to 1) carrying the whole score unchanged - whenever the payTo is shared
        // across operators (volume is the operator's, not attributable per service) or the status is
        // not 'measured' (no payTo, or an unmeasured network). Such services get neither reward nor
        // penalty. A 'measured', non-shared service with a true zero contributes ~0: an honest
        // reflection of no observed on-chain traction, not a fabricated penalty.
        const TRACTION_WEIGHT = 0.1;
        // Bounded 0..1 traction score = recency (0.4) + volume (0.35) + buyers (0.25). Volume and
        // buyers use log saturation so a few large services do not swamp the scale; recency decays
        // linearly from full at <=1 day stale to 0 at >=30 days. Each sub-score clamps to 0..1, so
        // the whole term is always bounded 0..1.
        const VOLUME_SAT_USD = 1000; // 30d volume at/above this saturates the volume sub-score to 1
        const BUYERS_SAT = 20; // 30d unique buyers at/above this saturates the buyers sub-score to 1
        const tractionScore = (t: ServiceTraction): number => {
          const last = t.last_settlement_at ? Date.parse(t.last_settlement_at) : NaN;
          const daysStale = Number.isFinite(last)
            ? (Date.now() - last) / 86_400_000
            : Number.POSITIVE_INFINITY;
          const recency = clamp01((30 - daysStale) / 29); // 1.0 at <=1d stale, 0 at >=30d
          const vol = Math.max(0, t.volume_usd_30d ?? 0);
          const volScore = clamp01(Math.log10(1 + vol) / Math.log10(1 + VOLUME_SAT_USD));
          const buyers = Math.max(0, t.unique_buyers_30d ?? 0);
          const buyersScore = clamp01(Math.log10(1 + buyers) / Math.log10(1 + BUYERS_SAT));
          return clamp01(0.4 * recency + 0.35 * volScore + 0.25 * buyersScore);
        };
        // The traction term for a service, or null when it must stay NEUTRAL (excluded + renormalized).
        // Traction is nested at assessment.traction (matching the API), not on the service top level.
        const tractionTerm = (s: ServiceListItem): number | null => {
          const t = s.assessment?.traction;
          if (!t || t.status !== "measured" || t.shared_payout === true) return null;
          return tractionScore(t);
        };

        // Explicit documented quality weights across the four measured families, by `prefer`.
        const qWeights = {
          balanced: { reliability: 0.35, compliance: 0.25, economics: 0.2, risk: 0.2 },
          most_reliable: { reliability: 0.5, compliance: 0.25, economics: 0.05, risk: 0.2 },
          cheapest: { reliability: 0.2, compliance: 0.15, economics: 0.5, risk: 0.15 },
          fastest: { reliability: 0.5, compliance: 0.15, economics: 0.15, risk: 0.2 },
        }[args.prefer];

        const scored = pool.map((s) => {
          const relevance = relevanceOf(s);
          const base =
            qWeights.reliability * reliabilityScore(s) +
            qWeights.compliance * complianceScore(s) +
            qWeights.economics * economicsScore(s) +
            qWeights.risk * riskScore(s);
          // D5: traction gets TRACTION_WEIGHT; when neutral it is excluded and the four family
          // weights (already summing to 1) carry the whole score unchanged (renormalized).
          const t = tractionTerm(s);
          const quality = t === null ? base : (1 - TRACTION_WEIGHT) * base + TRACTION_WEIGHT * t;
          // Relevance gates the ordering only when a query is present (50/50 blend);
          // otherwise the ranking is pure measured quality.
          const score = queryTokens.length === 0 ? quality : 0.5 * relevance + 0.5 * quality;
          return { s, score, relevance, quality };
        });

        // Deterministic sort: score desc, quality desc, verified desc, uptime desc, price asc, slug asc.
        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          if (b.quality !== a.quality) return b.quality - a.quality;
          if (Number(b.s.verified) !== Number(a.s.verified))
            return Number(b.s.verified) - Number(a.s.verified);
          const ua = a.s.uptime_24h ?? 0;
          const ub = b.s.uptime_24h ?? 0;
          if (ub !== ua) return ub - ua;
          const pa = a.s.min_price_usd ?? Number.POSITIVE_INFINITY;
          const pb = b.s.min_price_usd ?? Number.POSITIVE_INFINITY;
          if (pa !== pb) return pa - pb;
          return a.s.slug.localeCompare(b.s.slug);
        });

        const recommendations = scored.slice(0, args.limit).map((entry, i) => {
          const s = entry.s;
          return {
            rank: i + 1,
            slug: s.slug,
            name: s.name,
            category: s.category,
            status: s.status,
            verified: s.verified,
            uptime_24h: s.uptime_24h,
            avg_response_time_ms: s.avg_response_time_ms,
            min_price_usd: s.min_price_usd, // decimal USD verbatim (ENTRY / min price)
            // F2 price-range: the full price picture for tiered services (additive, read-only).
            price_max_usd: s.assessment?.price_max_usd ?? null, // highest tier; == min_price_usd when flat
            category_percentile_max: s.assessment?.category_percentile_max ?? null,
            distinct_price_count: s.assessment?.distinct_price_count ?? null, // 1 = flat, >1 = tiered
            networks: s.networks,
            endpoint_count: s.endpoint_count,
            compliance_grade: s.assessment?.compliance_grade ?? null,
            risk_level: s.assessment?.risk_level ?? null,
            capability_tags: s.assessment?.capability_tags ?? null,
            // Fase 2 on-chain traction (additive), read from assessment.traction to match the API.
            // Passed verbatim: null unless status is 'measured'. shared_payout=true => operator
            // volume, not attributable to this service. top_buyer_share_30d is PUBLISHED as a
            // concentration signal for the reader; it is NOT an input to the score (D5 traction
            // weight stays ~10%).
            ...tractionRecFields(s.assessment?.traction),
            score: Math.round(entry.score * 100) / 100,
            relevance: queryTokens.length === 0 ? null : Math.round(entry.relevance * 100) / 100,
            quality: Math.round(entry.quality * 100) / 100,
            why: buildWhy(s),
          };
        });

        return ok({
          recommendations,
          ranking_basis: rankingBasis,
          excluded_danger: excludedDanger,
          facilitator_context: facilitatorContext,
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
        "Get on-chain-verified settlement volume per x402 facilitator (the core x402-list metric). Returns USD settlement volume and transaction counts for 24h/7d/30d/all-time, plus a `verification` flag ('on-chain' when volume has been observed on-chain, else 'listed'). Optionally include a daily timeseries and per-chain breakdown. All volume figures are in US dollars. This is PER-FACILITATOR, not per-service.",
      inputSchema: {
        timeframe: z
          .enum(["24h", "7d", "30d", "all"])
          .default("7d")
          .describe("Drives the sort order of the returned facilitators."),
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
}

// ---- helpers ----

function buildWhy(s: ServiceListItem): string {
  const parts: string[] = [s.status];
  if (s.verified) parts.push("verified");
  if (s.uptime_24h !== null) parts.push(`${s.uptime_24h}% 24h uptime`);
  if (s.avg_response_time_ms !== null) parts.push(`${s.avg_response_time_ms}ms`);
  if (s.min_price_usd !== null) parts.push(`$${s.min_price_usd} min price`);
  const a = s.assessment;
  if (a?.compliance_grade && a.compliance_grade !== "unknown") parts.push(`compliance ${a.compliance_grade}`);
  if (a?.risk_level === "warning") parts.push("risk: warning");
  return parts.join(", ");
}

// The Fase 2 traction fields surfaced verbatim on each recommendation, read from
// assessment.traction to match the API. Every field is a passthrough (null unless status is
// 'measured'). shared_payout=true => operator volume, not attributable per service.
// top_buyer_share_30d is PUBLISHED as a concentration signal for the reader; it is NOT part of
// the ranking score (D5 traction weight stays ~10%). Exported so the recommendation shape is
// unit-testable without a live server.
export function tractionRecFields(t: ServiceTraction | null | undefined) {
  return {
    traction_status: t?.status ?? null,
    volume_usd_30d: t?.volume_usd_30d ?? null, // decimal USD, conservative undercount
    unique_buyers_30d: t?.unique_buyers_30d ?? null,
    shared_payout: t?.shared_payout ?? null,
    top_buyer_share_30d: t?.top_buyer_share_30d ?? null, // 0..1 concentration signal, not scored
  };
}

// x402 compliance grade -> 0..1 quality sub-score. unknown / unrecognized -> neutral 0.5.
function gradeScore(grade: string): number {
  return ({ A: 1.0, B: 0.8, C: 0.6, D: 0.4, F: 0.2 } as Record<string, number>)[grade] ?? 0.5;
}

// Split a free-text need into distinct lowercase tokens (>= 2 chars).
function tokenize(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

// Relevance of a service to the query tokens, 0..1. Per-token coverage: a hit in the
// MEASURED text (name/description/category) counts at full weight; a hit only in the
// AI-derived capability tags or summary counts at that field's confidence, so a
// 0.9-confidence capability tag ranks far above a 0-confidence one (which contributes
// nothing) and a measured fact always wins. AI provenance is honored, never faked.
function relevanceScore(s: ServiceListItem, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const tagField = s.assessment?.capability_tags ?? null;
  const summaryField = s.assessment?.summary ?? null;
  const tagConf = clamp01(tagField?.confidence ?? 0);
  const summaryConf = clamp01(summaryField?.confidence ?? 0);
  // value can be "unknown" (the marked-field sentinel); only real content matches.
  const tagVal = tagField?.value;
  const summaryVal = summaryField?.value;
  const tagText = (Array.isArray(tagVal) ? tagVal : []).join(" ").toLowerCase();
  const summaryText = (typeof summaryVal === "string" && summaryVal !== "unknown" ? summaryVal : "").toLowerCase();
  const measuredText = [s.name, s.description, s.category].join(" ").toLowerCase();
  let covered = 0;
  for (const t of tokens) {
    if (measuredText.includes(t)) covered += 1;
    else if (tagText.includes(t)) covered += tagConf;
    else if (summaryText.includes(t)) covered += summaryConf;
  }
  return clamp01(covered / tokens.length);
}

async function topFacilitatorContext() {
  const resp = await getFacilitators({ timeframe: "7d", per_page: 10, page: 1 });
  return resp.data.map((f) => ({
    facilitator_id: f.facilitator_id,
    name: f.name,
    volume_usd_7d: f.volume_usd_7d, // decimal USD verbatim
    tx_count_7d: f.tx_count_7d,
    verification: f.verification,
  }));
}
