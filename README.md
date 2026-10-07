# x402-list-mcp

[![Glama MCP server](https://glama.ai/mcp/servers/mcccsm/x402-list-mcp/badges/score.svg)](https://glama.ai/mcp/servers/mcccsm/x402-list-mcp)

Discover x402 payment APIs, check uptime and pricing, and inspect on-chain-verified settlement volume per facilitator through MCP.

## What is x402-list

[x402-list](https://x402-list.com) is a directory of services that accept x402 (HTTP 402 stablecoin) payments. It monitors listed services for uptime, response time and status, and measures facilitator settlement volume on-chain.

This package is a **thin wrapper** over the public x402-list HTTP JSON API. It holds no keys, touches no database, and makes no writes to the directory. It exposes the directory to AI agents through the Model Context Protocol as seven tools: six are free and read-only, and the seventh, `x402_assess_services`, is the only paid one, a pass-through that relays an x402 payment challenge you sign yourself client-side (the package never holds keys, never signs, and never settles).

## Install and quick start

Connect to the hosted server at `https://mcp.x402-list.com/mcp` using Streamable HTTP, or run the npm package locally over stdio. Local use requires Node.js 20 or newer and npm; the hosted connection needs no local Node.js installation.

### Claude Code

Connect to the hosted server:

```sh
claude mcp add --transport http x402-list https://mcp.x402-list.com/mcp
```

Or use the local package instead:

```sh
claude mcp add --transport stdio x402-list -- npx -y x402-list-mcp
```

Choose one transport. See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) for configuration scopes.

### Cursor

[Add the hosted server to Cursor](https://cursor.com/link/mcp/install?name=x402-list&config=eyJ1cmwiOiJodHRwczovL21jcC54NDAyLWxpc3QuY29tL21jcCJ9), then confirm the installation in Cursor.

The install link encodes the same configuration as this manual entry in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "x402-list": {
      "url": "https://mcp.x402-list.com/mcp"
    }
  }
}
```

See the [Cursor MCP documentation](https://cursor.com/docs/mcp) and [install-link format](https://cursor.com/docs/mcp/install-links).

### VS Code

Add this entry to `.vscode/mcp.json` in your project, then start the server from the editor and use it in Copilot agent mode:

```json
{
  "servers": {
    "x402-list": {
      "type": "http",
      "url": "https://mcp.x402-list.com/mcp"
    }
  }
}
```

See the [VS Code MCP documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers) for other configuration locations.

### Codex

Add the hosted server with the Codex CLI:

```sh
codex mcp add x402-list --url https://mcp.x402-list.com/mcp
```

Or add this entry to `~/.codex/config.toml`; the CLI and IDE extension share this configuration:

```toml
[mcp_servers.x402-list]
url = "https://mcp.x402-list.com/mcp"
```

See the [Codex MCP documentation](https://developers.openai.com/codex/mcp).

### Claude Desktop and other local stdio clients

Add this entry to `claude_desktop_config.json`, or the equivalent configuration for your stdio client, and restart the client:

```json
{
  "mcpServers": {
    "x402-list": {
      "command": "npx",
      "args": ["-y", "x402-list-mcp"]
    }
  }
}
```

See the [local MCP connection guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers) for the Claude Desktop configuration file location.

The client launches the same command you can run in a terminal:

```sh
npx -y x402-list-mcp
```

### Self-host Streamable HTTP

To run your own HTTP instance in a POSIX shell:

```sh
MCP_HTTP_PORT=3000 npx -y x402-list-mcp --http
```

Connect your client to `http://localhost:3000/mcp`. The health probe at `http://localhost:3000/healthz` returns `{"status":"ok"}`.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `X402_LIST_BASE_URL` | `https://x402-list.com` | API base URL. The `/api/v1` prefix is appended automatically. |
| `X402_LIST_TIMEOUT_MS` | `15000` | Per-request timeout in milliseconds. |
| `MCP_HTTP_PORT` / `PORT` | `3000` | HTTP port. Setting `MCP_HTTP_PORT` selects HTTP transport. |
| `MCP_ALLOWED_ORIGINS` | (empty, permissive) | Comma list of allowed CORS origins for HTTP mode. |
| `MCP_ALLOWED_HOSTS` | (empty, off) | Comma list that enables DNS-rebinding protection in HTTP mode. |

## Tools

| Tool | What it does |
| --- | --- |
| `x402_search_services` | Search and filter the directory by query, category, network, status, and `signable` (whether the last observed 402 envelope carries the EIP-712 domain parameters a standard x402 client needs in order to sign); sort by newest/uptime/cheapest/endpoints. |
| `x402_get_service` | Full detail for one service by slug: endpoints, per-endpoint USD pricing, uptime windows, networks, settlement asset. |
| `x402_find_best_service` | Ranked recommendation for a need, computed server-side (GET /api/v1/best). Ranks mostly by reliability, x402 compliance and price (status, verified, uptime, response time, USD price), with a small (~10%) weight on per-service on-chain traction that can never dominate those three. Read the answer's `ranking_version` to identify its scoring generation (see below), and its `units` map for scoring caveats. |
| `x402_check_health` | Live status, directory-wide or per service (uptime snapshots, consecutive failures). |
| `x402_facilitator_volumes` | Per-facilitator on-chain-verified settlement volume (today UTC/7d/30d/all) in USD, tx counts, and an on-chain vs listed flag. The `*_24h` fields cover today (UTC) so far, not a trailing 24-hour window. |
| `x402_change_events` | Free, read-only feed of what the monitor observed changing on listed services, most recent first, in exactly three event types (`payto_changed`, `price_changed`, `schema_changed`). Filter by `service` (the listing slug: the parameter is named `service`, not `slug`), by `type`, and by `days` (1 to 365, default 90); page with `page` / `per_page` (up to 100 per page). Each event carries the observation timestamp, a diff summary, and the before/after 402 snapshots. Prices inside an event are atomic token amounts, never dollars, and every payout address is returned masked by the API: the feed reports THAT the payTo changed, never the address. |
| `x402_assess_services` | **Paid** ($0.25 USDC on Base, x402). Fresh on-demand AI comparison of a shortlist of listed services for a stated need. Pass-through: it never holds keys, never signs, and never settles. Call without `payment_signature_b64` to get the x402 challenge verbatim, sign it client-side, then retry with the signature to get the report. Optionally add a `probe` target `{ slug, endpoint_path? }` to also test one listed service live: the price becomes $0.25 plus that endpoint price X (non-refundable), and the report gains a `probe_report` block with a verdict and truncated extracts, never the verbatim third-party body. |

## Ranking generations

`x402_find_best_service` returns its scoring generation in `ranking_version`. Compare scores only
within the same generation. The changes below explain why scores across generations differ:

- **Generation 2** capped the compliance term at 0.6, the floor of the C band, when at least one of a
  service's EVM routes was observed missing the EIP-712 domain parameters (`extra.name`, `extra.version`)
  a standard x402 client needs in order to sign a payment. A fact about the envelope on the wire, not a
  judgement on the merit of the service.
- **Generation 3** added the anti-wash rules on the traction term: an absolute floor of $10 on 30d
  settlement volume, below which the term scores 0 because sub-floor volume is indistinguishable from
  dust and must not move rank; a discount on a payout concentrated in one buyer, up to half the traction
  term when a single buyer accounts for all of it, since one buyer is one relationship and not the broad
  demand the term is meant to reward; and a service that publishes no mappable payTo now scores 0 on that
  term instead of having the weight renormalized away, so hiding the payout address no longer beats
  having a measured one.

## Units note

All monetary values are decimal US dollars and are passed through verbatim. There is no cents conversion anywhere. The per-endpoint `pricing[].price` field is a raw atomic on-chain token amount (a uint256 string), not dollars; only `price_usd` is the dollar figure.

## Honesty note

Two different on-chain volume signals; do not conflate them. **Facilitator volume** (`x402_facilitator_volumes`) is the ecosystem headline, aggregated per facilitator. **Per-service traction** (the `traction` block on each service, weighed at ~10% inside `x402_find_best_service`) is settlement measured over a service's own payTo via recognized settlers - a deliberate **conservative undercount**, not an estimate: unattributed settlements are left out, never scaled up. When a payTo is shared across services (`shared_payout: true`), only settlement VOLUME is attributed pro-quota, the operator-level volume over that address divided across the services sharing it, which is a declared convention and not an individually observed measure, while transaction count and unique buyers stay whole operator-level integers; a service on a network not yet measured, or a shared-payout member whose probe has been failing, carries no traction term at all and the remaining weights are renormalized over it. Never read shared, pro-quota or unmeasured volume as one service's revenue. To ask "which facilitators have real on-chain volume", use `x402_facilitator_volumes` and read the `verification` flag.

## Source

Source code: [mcccsm/x402-list-mcp](https://github.com/mcccsm/x402-list-mcp). This repository mirrors the MCP package when it is published. The public REST API is documented at [x402-list.com/api](https://x402-list.com/api).

## License

MIT
