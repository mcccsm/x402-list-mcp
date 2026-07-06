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
} from "./api.js";

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
      try {
        const resp = await getService(args.slug);
        return ok({
          service: resp.data, // full ServiceDetail verbatim
          units: {
            min_price_usd: "decimal US dollars (number)",
            "pricing.price_usd": "decimal US dollars (string)",
            "pricing.price":
              "ATOMIC on-chain token units (uint256 string), NOT dollars, do not rescale",
            uptime:
              "percentages 0-100 for windows 24h/7d/30d/90d; null = not yet monitored in that window (0 = observed down)",
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
  // 3.3 find_best_service (HONESTY-GUARDED: reliability/price, NOT volume)
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_best_service",
    {
      description:
        "Recommend the best x402 service(s) for a need, ranked ONLY by fields that exist per service: live status, verification, uptime (24h), response time, and price (USD), filtered by category and network. IMPORTANT: x402-list does NOT track settlement volume per service (volume is per-facilitator only), so this ranking is by reliability and price, not by transaction volume. Optionally attach ecosystem facilitator-volume context separately.",
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
      try {
        const net = args.network ? await resolveNetwork(args.network) : null;
        // 1. Strong candidate pool: online-first, server-sorted by uptime.
        const first = await getServices({
          q: args.q,
          category: args.category,
          network: net?.abbrev,
          status: "online",
          sort: "uptime",
          per_page: 100,
          page: 1,
        });
        const bySlug = new Map<string, ServiceListItem>();
        for (const s of first.data) bySlug.set(s.slug, s);

        // Widen if too few candidates: drop the status filter, merge by slug.
        if (bySlug.size < args.limit) {
          const widen = await getServices({
            q: args.q,
            category: args.category,
            network: net?.abbrev,
            status: undefined,
            sort: "uptime",
            per_page: 100,
            page: 1,
          });
          for (const s of widen.data) if (!bySlug.has(s.slug)) bySlug.set(s.slug, s);
        }

        // 2. Hard filters (re-assert client-side; the API ignores an unknown network).
        let pool = [...bySlug.values()];
        if (net) pool = pool.filter((s) => s.networks.includes(net.abbrev));
        if (args.category) pool = pool.filter((s) => s.category === args.category);
        if (args.max_price_usd !== undefined) {
          pool = pool.filter(
            (s) => s.min_price_usd !== null && s.min_price_usd <= args.max_price_usd!,
          );
        }
        if (args.require_verified) pool = pool.filter((s) => s.verified === true);

        const facilitatorContext = args.include_facilitator_context
          ? await topFacilitatorContext()
          : null;

        const rankingBasis =
          "Ranked by status, verification, uptime_24h, response time, and min_price_usd. x402-list does not expose per-service settlement volume; this is NOT a volume ranking.";

        if (pool.length === 0) {
          return ok({
            recommendations: [],
            ranking_basis: rankingBasis,
            note:
              net && !net.recognized
                ? `network '${args.network}' did not match any known network (${await knownNetworksHint()}); no services match it`
                : "no services match the hard filters",
            facilitator_context: facilitatorContext,
          });
        }

        // 3. Sub-scores normalized to 0..1 (higher = better).
        const statusScore = (s: ServiceListItem) =>
          ({ online: 1.0, degraded: 0.5, unknown: 0.25, offline: 0.0 }[s.status]);
        const verifiedScore = (s: ServiceListItem) => (s.verified ? 1.0 : 0.0);
        const uptimeScore = (s: ServiceListItem) => (s.uptime_24h ?? 0) / 100;

        const rtVals = pool
          .map((s) => s.avg_response_time_ms)
          .filter((v): v is number => v !== null);
        const rtMin = rtVals.length ? Math.min(...rtVals) : 0;
        const rtMax = rtVals.length ? Math.max(...rtVals) : 1;
        const speedScore = (s: ServiceListItem) =>
          s.avg_response_time_ms === null
            ? 0.5
            : rtMax === rtMin
              ? 1.0
              : 1 - (s.avg_response_time_ms - rtMin) / (rtMax - rtMin);

        const pVals = pool
          .map((s) => s.min_price_usd)
          .filter((v): v is number => v !== null);
        const pMin = pVals.length ? Math.min(...pVals) : 0;
        const pMax = pVals.length ? Math.max(...pVals) : 1;
        const priceScore = (s: ServiceListItem) =>
          s.min_price_usd === null
            ? 0.5
            : pMax === pMin
              ? 1.0
              : 1 - (s.min_price_usd - pMin) / (pMax - pMin);

        // 4. Weights by `prefer`.
        const weights = {
          balanced: { status: 0.3, verified: 0.2, uptime: 0.25, speed: 0.1, price: 0.15 },
          most_reliable: { status: 0.35, verified: 0.25, uptime: 0.3, speed: 0.05, price: 0.05 },
          cheapest: { status: 0.2, verified: 0.1, uptime: 0.15, speed: 0.05, price: 0.5 },
          fastest: { status: 0.25, verified: 0.1, uptime: 0.15, speed: 0.4, price: 0.1 },
        }[args.prefer];

        // 5. Composite score.
        const scored = pool.map((s) => {
          const score =
            weights.status * statusScore(s) +
            weights.verified * verifiedScore(s) +
            weights.uptime * uptimeScore(s) +
            weights.speed * speedScore(s) +
            weights.price * priceScore(s);
          return { s, score };
        });

        // 6. Deterministic sort: score desc, verified desc, uptime desc, price asc, slug asc.
        scored.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
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
            min_price_usd: s.min_price_usd, // decimal USD verbatim
            networks: s.networks,
            endpoint_count: s.endpoint_count,
            score: Math.round(entry.score * 100) / 100,
            why: buildWhy(s),
          };
        });

        return ok({
          recommendations,
          ranking_basis: rankingBasis,
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
  return parts.join(", ");
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
