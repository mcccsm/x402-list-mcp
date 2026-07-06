# x402-list-mcp

MCP server for x402-list: discover x402 payment services and on-chain-verified facilitator settlement volume.

## What is x402-list

[x402-list](https://x402-list.com) is the directory of services that accept x402 (HTTP 402 stablecoin) payments. Its distinctive, defensible data is **on-chain-verified settlement volume per facilitator**, not self-reported numbers. Listed services are continuously health-monitored (uptime, response time, status).

This package is a **thin, read-only wrapper** over the public x402-list HTTP JSON API. It holds no keys, touches no database, and makes no writes. It exposes the directory to AI agents through the Model Context Protocol.

## Install and quick start

### stdio (local MCP clients)

```
npx -y x402-list-mcp
```

Claude Desktop / generic MCP client config:

```json
{ "mcpServers": { "x402-list": { "command": "npx", "args": ["-y", "x402-list-mcp"] } } }
```

### Hosted HTTP (Streamable HTTP transport)

```
MCP_HTTP_PORT=3000 npx -y x402-list-mcp --http
```

Hosted endpoint: `https://mcp.x402-list.com/mcp`. Health probe: `GET /healthz` returns `{"status":"ok"}`.

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
| `search_x402_services` | Search and filter the directory by query, category, network, status; sort by newest/uptime/cheapest/endpoints. |
| `get_service` | Full detail for one service by slug: endpoints, per-endpoint USD pricing, uptime windows, networks, settlement asset. |
| `find_best_service` | Ranked recommendation for a need. Ranks by reliability and price (status, verified, uptime, response time, USD price), NOT by settlement volume. |
| `check_health` | Live status, directory-wide or per service (uptime snapshots, consecutive failures). |
| `get_facilitator_volumes` | Per-facilitator on-chain-verified settlement volume (24h/7d/30d/all) in USD, tx counts, and an on-chain vs listed flag. |

## Units note

All monetary values are decimal US dollars and are passed through verbatim. There is no cents conversion anywhere. The per-endpoint `pricing[].price` field is a raw atomic on-chain token amount (a uint256 string), not dollars; only `price_usd` is the dollar figure.

## Honesty note

Settlement volume is tracked **per facilitator only**, never per service. `find_best_service` does not rank by volume and never implies a per-service revenue figure. To ask "which facilitators have real on-chain volume", use `get_facilitator_volumes` and read the `verification` flag.

## Source

The source code is not public yet. This package is a thin read-only wrapper over the public x402-list REST API, documented at https://x402-list.com/api.

## License

MIT
