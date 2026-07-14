// Per-tool usage telemetry to Rybbit (the same self-hosted instance and the SAME site the
// x402-list web app uses, site 25), so MCP tool volume shows up in the one dashboard Cosimo
// already reads. Events are namespaced `mcp:<tool>` and carry ONLY structured, non-PII
// properties (enums, network/category codes, a public listing slug) — NEVER the free-text
// query an agent typed.
//
// TRUST / NO SURPRISE TELEMETRY: this is a strict NO-OP unless BOTH PUBLIC_RYBBIT_SITE_ID and
// RYBBIT_API_KEY are set. Those env vars are set ONLY on the hosted container (mcp.x402-list.com);
// they are never baked into the published npm package (no key is in this file — it is read at
// runtime), so a local `npx x402-list-mcp` install phones home to nobody. Same gate posture as
// the web app's src/lib/analytics/track.ts, of which this is a plain-Node mirror.
//
// Fire-and-forget: never awaited on the tool path, all failures swallowed, hard 2s timeout. A
// telemetry failure can never change or delay a tool response.

const RYBBIT_ENDPOINT = "https://analytics.x402-list.com/api/track";

export function trackTool(tool: string, props: Record<string, unknown>): void {
  try {
    const siteId = process.env.PUBLIC_RYBBIT_SITE_ID;
    const apiKey = process.env.RYBBIT_API_KEY;
    if (!siteId || !apiKey) return;
    // Prod Rybbit is v2.7, which rejects an api_key in the strict body and wants it in the
    // Authorization header. Mirror the web app: default 'body' (v2.2.3), 'bearer' via env.
    const useBearer = process.env.RYBBIT_AUTH_MODE === "bearer";

    // properties must be valid JSON under Rybbit's 2048-char cap, else the whole event 400s.
    // Ours is tiny; guard anyway and fall back to an empty object rather than a rejected event.
    let properties: string;
    try {
      properties = JSON.stringify(props ?? {});
      if (properties.length > 2048) properties = "{}";
    } catch {
      properties = "{}";
    }

    const body: Record<string, unknown> = {
      type: "custom_event",
      site_id: String(siteId),
      event_name: `mcp:${tool}`,
      pathname: `/mcp/${tool}`,
      hostname: "mcp.x402-list.com",
      properties,
    };
    if (!useBearer) body.api_key = apiKey;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (useBearer) headers.authorization = `Bearer ${apiKey}`;

    fetch(RYBBIT_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    // Telemetry must never throw into a tool handler.
  }
}
