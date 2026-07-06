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
const USER_AGENT = "x402-list-mcp/0.1.1 (+https://x402-list.com)";

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
// There is NO `verified` query filter; verified is filtered client-side in tools.ts.

export const getServices = (q: {
  page?: number;
  per_page?: number;
  status?: string;
  category?: string;
  network?: string;
  sort?: string;
  q?: string;
}) => apiGet<ServiceListItem[]>("/services", q) as Promise<ServicesListResponse>;

export const getService = (slug: string) =>
  apiGet<ServiceDetail>(`/services/${encodeURIComponent(slug)}`);

export const getServiceUptime = (slug: string, period?: string) =>
  apiGet<UptimeSnapshot[]>(`/services/${encodeURIComponent(slug)}/uptime`, { period });

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
