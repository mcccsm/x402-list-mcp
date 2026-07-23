// Typed, read-only HTTP client over the PUBLIC x402-list JSON API.
// No DB, no money-path, no writes. Native fetch only (Node 20+).
//
// MONETARY UNITS: every *_usd / *_price_usd / volume_usd_* field is already
// decimal US dollars and is passed through verbatim. The one trap is
// pricing[].price, which is an ATOMIC on-chain token amount (uint256 string),
// NOT money. This module never coerces or rescales any value.

const BASE = (process.env.X402_LIST_BASE_URL ?? "https://x402-list.com").replace(/\/+$/, "");
const PREFIX = "/api/v1";
const DEFAULT_TIMEOUT_MS = Number(process.env.X402_LIST_TIMEOUT_MS ?? 15000);
// version: keep in sync with package.json / server.json / SERVER_INFO in server.ts.
// Exported so the version-sync test can assert it carries the same version as the others.
export const USER_AGENT = "x402-list-mcp/0.3.0 (+https://x402-list.com)";

export interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export class ApiError extends Error {
  status: number;
  body?: unknown;
  constructor(message: string, o: { status: number; body?: unknown; cause?: unknown }) {
    super(message, { cause: o.cause });
    this.name = "ApiError";
    this.status = o.status;
    this.body = o.body;
  }
}

export async function apiGet<T>(
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
  opts?: { timeoutMs?: number },
): Promise<ApiEnvelope<T>> {
  const url = new URL(BASE + PREFIX + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new ApiError(`Network error calling ${path}`, { cause: e, status: 0 });
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* leave undefined */
  }
  if (!res.ok) {
    // upstream error shape: { error: { code, message } }
    const msg = body?.error?.message ?? `HTTP ${res.status} from ${path}`;
    throw new ApiError(msg, { status: res.status, body });
  }
  if (!body || !("data" in body)) {
    throw new ApiError(`Malformed response from ${path} (no data field)`, { status: res.status, body });
  }
  return body as ApiEnvelope<T>;
}

// ---- Typed response interfaces (mirror the API verbatim) ----

// Filone 2 assessment shapes. Declared here BY HAND (the MCP package imports nothing
// from the root src/lib): these mirror src/lib/assessment/serialize.ts. Fields flagged
// {value, confidence, source:'ai'} are AI-derived (family 10) and never override a
// measured value; 'unknown'/null are honest, not zero.

/** An AI-derived (family 10) field with its own provenance + confidence. */
export interface AiMarkedField<T = string> {
  value: T | "unknown";
  confidence: number; // 0..1
  source: "ai";
}

/** Compact assessment summary carried on each list item (backs ranking). */
export interface AssessmentSummary {
  compliance_grade: "A" | "B" | "C" | "D" | "F" | "unknown" | null;
  compliance_passed: number | null;
  compliance_total: number | null;
  // Machine-stable ids of the conformance checks that FAILED (pass === false), for naming the
  // failed check inline without pulling the full detail checklist. [] = all evaluable checks pass;
  // null = no gradeable compliance. Human labels live in the detail assessment.compliance.checks[].
  compliance_failed_checks: string[] | null;
  reliability_uptime_30d: number | null; // 0-100
  response_p95_ms: number | null;
  price_usd: number | null; // decimal USD (ENTRY / min price)
  category_percentile: number | null; // 0-100 within its category, ranked on the min price (lower = cheaper)
  price_stability: number | null; // 0-1, 1 = price never moved
  // F2 price-range (additive; null on rows stored before the field set existed).
  price_max_usd: number | null; // decimal USD (highest tier); == price_usd when flat
  category_percentile_max: number | null; // 0-100, ranked on the max price among every service's max in the category
  endpoint_count: number | null; // count of active priced endpoints
  distinct_price_count: number | null; // count of distinct current prices (1 = flat, >1 = tiered)
  risk_level: "clean" | "warning" | "danger" | null;
  // AI-derived (family 10): carry the {value,confidence,source:'ai'} provenance so a
  // ranker can tell an AI guess from a measured fact and weight by confidence. null when
  // the model could not ground them.
  capability_tags: AiMarkedField<string[]> | null;
  summary: AiMarkedField<string> | null; // AI-derived one-liner; null when unknown
  // Fase 2 (family 6) on-chain traction; nested here by the API (assessment.traction),
  // NOT at the service top level. null on rows assessed before the traction build (W4).
  traction: ServiceTraction | null;
  updated_at: string | null;
}

/** Full evidence-backed assessment on the service detail. */
export interface AssessmentDetail {
  updated_at: string | null;
  input_hash: string | null;
  model_id: string | null;
  prompt_version: string | null;
  reliability: {
    uptime: { "24h": number | null; "7d": number | null; "30d": number | null; "90d": number | null };
    response_p95_ms: number | null;
    avg_response_ms: number | null;
    last_checked_at: string | null;
    consecutive_failures: number | null;
    total_checks: number | null;
  } | null;
  compliance: {
    grade: "A" | "B" | "C" | "D" | "F" | "unknown";
    passed: number;
    total: number;
    checks: { id: string; label: string; pass: boolean | null }[];
    pay_to_source: "payTo" | "payToAddress" | "treasury" | null;
    pay_to_location: "accept" | "element" | null;
  } | null;
  site: {
    homepage: boolean | null;
    openapi: boolean | null;
    pricing: boolean | null;
    llms_txt: boolean | null;
    robots: boolean | null;
    terms: boolean | null;
    checked_at: string | null;
  } | null;
  domain: {
    age_days: number | null;
    registrar: string | null;
    free_host: boolean | null;
    created_date: string | null;
    checked_at: string | null;
  } | null;
  economics: {
    price_usd: number | null;
    price_atomic: string | null;
    model: "flat" | "per-token" | "tiered" | "free" | "unknown";
    category_percentile: number | null;
    stability: number | null;
    // F2 price-range (additive; null on rows stored before the field set existed).
    price_max_usd: number | null;
    category_percentile_max: number | null;
    endpoint_count: number | null;
    distinct_price_count: number | null;
  } | null;
  risk: {
    level: "clean" | "warning" | "danger";
    flags: { level: "danger" | "warning"; code: string; evidence: string }[];
  } | null;
  synthesis: {
    summary: AiMarkedField<string> | null;
    capability_tags: AiMarkedField<string[]> | null;
    category: AiMarkedField<string> | null;
    inputs: AiMarkedField<string> | null;
    outputs: AiMarkedField<string> | null;
    auth: AiMarkedField<string> | null;
  } | null;
  // Fase 2 (family 6) on-chain traction; nested here by the API (assessment.traction),
  // NOT at the service top level. null on rows assessed before the traction build (W4).
  traction: ServiceTraction | null;
}

/** Family 6 - On-chain traction (Fase 2). Additive, identical shape on the list item and the
 * detail. Every metric is measured deterministically on-chain over the service's known payTo
 * addresses via recognized settlers (a CONSERVATIVE UNDERCOUNT: settlements the monitor has not
 * attributed are simply not counted, never estimated up). null != 0 is load-bearing:
 *   - status 'measured'          -> the metrics are real numbers; a 0 is an HONEST zero
 *                                   ("known payTo on a measured network, never settled on-chain").
 *   - status 'no-payto'          -> no payTo is known for this service; metrics are null, not 0.
 *   - status 'unmeasured-network'-> the only payTo(s) sit on a network we do not yet measure;
 *                                   metrics are null, not 0.
 *   - status 'unresponsive'      -> a shared-payout member whose probe has been failing past the
 *                                   decay window; its share of the shared address is suppressed
 *                                   (metrics null), not attributed to it while it is down.
 * shared_payout=true means the payTo is shared across more than one service; volume_usd_30d,
 * tx_count_30d and unique_buyers_30d are then attributed PRO-QUOTA (the operator-level figure
 * divided by the N current members sharing the payout) - a declared convention, not an individually
 * observed measure. The ratios top_buyer_share_30d and trend_7d_vs_30d are left whole (invariant
 * under the division), and unique_buyers_30d can be fractional. */
export interface ServiceTraction {
  status: "measured" | "no-payto" | "unmeasured-network" | "unresponsive";
  volume_usd_30d: number | null; // decimal USD settled on-chain over 30 UTC days; shared => pro-quota (/N)
  tx_count_30d: number | null; // settlement count over 30 UTC days; shared => pro-quota (/N)
  unique_buyers_30d: number | null; // distinct payers over 30 UTC days; shared => pro-quota (/N), may be fractional
  last_settlement_at: string | null; // ISO 8601 of the most recent settlement, over all history
  top_buyer_share_30d: number | null; // 0..1, volume share of the single largest buyer over 30d (a ratio, not divided)
  trend_7d_vs_30d: number | null; // ratio of the last-7d daily rate vs the 30d daily rate (not divided)
  shared_payout: boolean; // payTo shared across services => volume/buyers attributed pro-quota (/N)
  shared_with: number; // count of OTHER services sharing the payTo (0 when not shared); N = shared_with + 1
  measured_networks: string[]; // canonical CAIP-2 networks that contributed a measurement
  // TRENO A additive (mirror of the root serializer). Always emitted by the API; null/[] when the
  // stored snapshot predates the extension or the status is not 'measured' (null != 0). The all-time
  // COUNTING figures (volume_usd_all_time / tx_count_all_time) follow the SAME pro-quota /N convention
  // as the 30d ones. first_settlement_at, the per-settlement median/max, settled_via and
  // shared_with_services are INVARIANT facts and are never divided.
  first_settlement_at: string | null; // ISO 8601 of the first settlement ever recorded; null when never settled
  volume_usd_all_time: number | null; // decimal USD since listing; shared => pro-quota (/N)
  tx_count_all_time: number | null; // settlement count since listing; shared => pro-quota (/N)
  median_settlement_usd_30d: number | null; // median single-settlement amount over 30d (invariant, never divided)
  max_settlement_usd_30d: number | null; // largest single-settlement amount over 30d (invariant, never divided)
  settled_via: string[]; // facilitator ids that settled this service over 30d, ordered by volume; [] when none
  shared_with_services: { slug: string; name: string }[]; // sibling services on a shared payout; [] when not shared
}

export interface ServiceListItem {
  slug: string;
  name: string;
  description: string;
  base_url: string;
  website_url: string | null;
  category: string;
  status: "online" | "degraded" | "offline" | "unknown";
  verified: boolean;
  endpoint_count: number;
  min_price_usd: number | null; // decimal USD
  networks: string[]; // network abbreviations, e.g. ["BSE","SOL"]
  networks_caip2: string[]; // canonical CAIP-2 ids, index-aligned with networks
  uptime_24h: number | null; // 0-100; null = not yet monitored
  avg_response_time_ms: number | null;
  last_checked_at: string | null;
  created_at: string | null;
  // Filone 2 compact assessment summary; null until the service is first assessed.
  // Fase 2 (family 6) on-chain traction is nested INSIDE this (assessment.traction),
  // matching the API; there is no top-level traction field on the service.
  assessment?: AssessmentSummary | null;
}
export interface ServicesListResponse {
  data: ServiceListItem[];
  meta: { total: number; page: number; per_page: number; total_pages: number };
}

export interface PricingEntry {
  scheme: string;
  network: string; // raw network id as reported (usually CAIP-2, casing may vary)
  network_caip2: string | null; // canonical CAIP-2; null when the raw id is not recognized
  asset_address: string | null; // raw token address; null = not reported
  asset_address_norm: string | null; // normalized (EVM lowercased); null = not reported
  asset_name: string;
  price: string; // ATOMIC token units (uint256 string). NOT money.
  price_usd: string; // decimal USD as STRING e.g. "0.0010000000"
  pay_to: string;
  max_timeout_seconds: number;
}
export interface ServiceEndpoint {
  id: string;
  method: string;
  path: string;
  description: string | null;
  mime_type: string | null;
  is_active: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
  min_price_usd: number | null; // decimal USD (number)
  networks: string[];
  pricing: PricingEntry[];
}
export interface ServiceDetail {
  slug: string;
  name: string;
  description: string;
  base_url: string;
  website_url: string | null;
  category: string;
  status: "online" | "degraded" | "offline" | "unknown";
  verified: boolean;
  consecutive_failures: number;
  check_interval_minutes: number;
  last_checked_at: string | null;
  created_at: string | null;
  // Each window is null when the service has not been monitored in it yet
  // (null = not yet monitored, 0 = observed down).
  uptime: { "24h": number | null; "7d": number | null; "30d": number | null; "90d": number | null };
  avg_response_time_ms: number | null;
  total_checks: number;
  networks: string[];
  networks_caip2: string[]; // canonical CAIP-2 ids, index-aligned with networks
  asset: string;
  endpoints: ServiceEndpoint[];
  // Filone 2 full evidence-backed assessment; null until the service is first assessed.
  // Fase 2 (family 6) on-chain traction is nested INSIDE this (assessment.traction),
  // matching the API; there is no top-level traction field on the service.
  assessment?: AssessmentDetail | null;
}

export interface UptimeSnapshot {
  period_start: string;
  period_end: string;
  uptime_percentage: number;
  avg_response_time_ms: number;
  total_checks: number;
  successful_checks: number;
}

export interface FacilitatorChain {
  network: string; // raw chain id as configured ('base', full Solana genesis hash, or eip155:*)
  network_caip2: string | null; // canonical CAIP-2; null when the raw id is not recognized
  token_address: string | null;
  token_address_norm: string | null; // normalized (EVM lowercased); null = unknown
  asset_name: string;
  volume_usd_24h: number;
  volume_usd_7d: number;
  volume_usd_30d: number;
  volume_usd_all: number;
  tx_count_all: number;
  last_activity_at: string | null;
  verification: "on-chain" | "listed";
}
export interface Facilitator {
  facilitator_id: string;
  name: string;
  website_url: string | null;
  volume_usd_24h: number;
  volume_usd_7d: number;
  volume_usd_30d: number;
  volume_usd_all: number;
  tx_count_24h: number;
  tx_count_7d: number;
  tx_count_30d: number;
  tx_count_all: number;
  last_activity_at: string | null;
  settler_count: number;
  verification: "on-chain" | "listed";
  timeseries?: Array<{ date: string; volume_usd: number; tx_count: number }>;
  chains?: FacilitatorChain[];
}
export interface FacilitatorsResponse {
  data: Facilitator[];
  meta: { total: number; page: number; per_page: number; total_pages: number; timeframe: string };
}

export interface StatusServiceItem {
  slug: string;
  name: string;
  status: "online" | "degraded" | "offline" | "unknown";
  last_checked_at: string | null;
  consecutive_failures: number;
  uptime_24h: number | null;
  avg_response_time_ms: number | null;
}
export interface StatusResponse {
  total: number;
  online: number;
  degraded: number;
  offline: number;
  unknown: number;
  services: StatusServiceItem[];
}

// ---- Endpoint wrappers (the ONLY place that knows paths and param names) ----
// Full-text search param is `q`; pagination is `page` / `per_page`.
// `verified` IS a real query filter on /services, applied SQL-side by the API: meta.total counts the
// filtered set, so list_services passes it through instead of filtering the page it got back.
// (find_best_service still narrows its own scored pool in tools.ts: that is ranking, not this param.)

export const getServices = (q: {
  page?: number;
  per_page?: number;
  status?: string;
  category?: string;
  network?: string;
  sort?: string;
  q?: string;
  /** true = verified only, false = unverified only, omit = no filter. Filtered SQL-side, so meta.total follows. */
  verified?: boolean;
}) => apiGet<ServiceListItem[]>("/services", q) as Promise<ServicesListResponse>;

export const getService = (slug: string) =>
  apiGet<ServiceDetail>(`/services/${encodeURIComponent(slug)}`);

export const getServiceUptime = (slug: string, period?: string) =>
  apiGet<UptimeSnapshot[]>(`/services/${encodeURIComponent(slug)}/uptime`, { period });

// On-chain daily series (Fase 2). One point per UTC day, oldest first, measured over the service's
// payTo mapping via recognized settlers - a conservative undercount. USD passthrough (no rescale).
export interface ServiceVolumePoint {
  date: string; // UTC day, YYYY-MM-DD
  volume_usd: number; // decimal USD settled on-chain that day
  tx_count: number; // settlement count that day
}
export interface ServiceBuyersPoint {
  date: string; // UTC day, YYYY-MM-DD
  unique_buyers: number; // distinct on-chain buyers that day (upper bound for a multi-address service)
}
// These two series routes wrap their array in { data, caveat } (no meta): caveat is the in-band
// do-not-sum / suppression note, passed through verbatim from the API.
export interface SeriesResponse<T> {
  data: T[];
  caveat?: string;
}
export const getServiceVolumeSeries = (slug: string, period?: string) =>
  apiGet<ServiceVolumePoint[]>(`/services/${encodeURIComponent(slug)}/volume`, { period }) as Promise<
    SeriesResponse<ServiceVolumePoint>
  >;
export const getServiceBuyersSeries = (slug: string, period?: string) =>
  apiGet<ServiceBuyersPoint[]>(`/services/${encodeURIComponent(slug)}/buyers`, { period }) as Promise<
    SeriesResponse<ServiceBuyersPoint>
  >;

export const getFacilitators = (q: {
  page?: number;
  per_page?: number;
  timeframe?: string;
  include?: string;
  days?: number;
}) => apiGet<Facilitator[]>("/facilitators", q) as Promise<FacilitatorsResponse>;

export const getStatus = () => apiGet<StatusResponse>("/status");

export const getCategories = () => apiGet<string[]>("/categories");

export interface NetworkItem {
  id: string;
  caip2_id: string; // as stored (may be lowercase); kept for backwards compatibility
  caip2: string; // canonical CAIP-2 for cross-endpoint joins
  name: string; // human name, e.g. "Base"
  abbreviation: string; // the value used in ServiceListItem.networks[], e.g. "BSE"
  chain_type: string;
  is_mainnet: boolean;
  explorer_url: string | null;
  service_count: number;
  avg_uptime: number | null;
}
export const getNetworks = () => apiGet<NetworkItem[]>("/networks");
