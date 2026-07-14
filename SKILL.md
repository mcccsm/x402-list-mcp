---
name: x402-list
description: Discover x402 payment services and on-chain-verified facilitator settlement volume via the x402-list directory. Use when a user or agent needs to find an API/service that accepts x402 (HTTP 402 stablecoin) payments, compare services by reliability and price, check service uptime/health, or look up which x402 facilitators have real on-chain settlement volume.
---

# x402-list

## What x402-list is

x402-list is a directory of services that accept x402 payments. Its distinctive, defensible data is **on-chain-verified settlement volume per facilitator**, not self-reported figures. Listed services are continuously health-monitored for uptime, response time, and live status. This MCP server is a read-only wrapper over the public x402-list API; it needs no API key.

## Money units (read this first)

**All `*_usd` fields are decimal US dollars and are used as-is. There is no cents conversion.** For example `min_price_usd: 0.001` means one tenth of a cent, and `volume_usd_all: 1542635.84` means about 1.54 million dollars. The service-detail `pricing[].price` field is an atomic on-chain token amount (a uint256 string), NOT dollars; only `price_usd` is the dollar figure. Never rescale either one.

## Tool guide (when to use each)

- `search_x402_services`: find and filter services by free-text query, category, network, and status; sort by newest, uptime, cheapest, or endpoint count. Start here for discovery.
- `get_service`: deep-dive one service by slug. Returns every endpoint, per-endpoint USD pricing, uptime windows (24h/7d/30d/90d), accepted networks, and the settlement asset.
- `find_best_service`: get a ranked recommendation for a need. Ranks mostly by reliability, x402 compliance and price (status, verified, uptime_24h, response time, USD price), filtered by category and network, with a small (~10%) weight on per-service on-chain traction (settlement volume, tx count, unique buyers - a conservative undercount). Traction never dominates; shared-payout or unmeasured-network services stay neutral.
- `check_health`: live status. With no slug, a directory-wide snapshot (online/degraded/offline/unknown counts plus per-service status). With a slug, that service's status, uptime windows, response time, consecutive failures, and recent daily uptime snapshots.
- `get_facilitator_volumes`: the headline metric. Per-facilitator settlement volume (24h/7d/30d/all) in USD, transaction counts, and an `on-chain` vs `listed` verification flag. Optional daily timeseries and per-chain breakdown.

## The honesty guard

Keep two on-chain signals distinct. **Facilitator volume** (`get_facilitator_volumes`) is aggregated per facilitator and is the headline metric. **Per-service traction** (the `traction` block on a service, and a ~10% weight inside `find_best_service`) is measured over that service's own payTo via recognized settlers and is a deliberate **conservative undercount** - never an upper bound, never an estimate. When a payTo is shared across services (operator-level volume, `shared_payout: true`) or sits on a network we do not measure, there is no per-service figure and the service stays neutral in the ranking; do not present shared or unmeasured volume as a single service's revenue. If asked "which service does the most volume", show the measured `traction` where it exists, flag the undercount and any shared/unmeasured caveat, and offer facilitator volumes (via `get_facilitator_volumes`) for the ecosystem aggregate.

## Typical workflows

- "Find me a cheap, reliable image-generation x402 API on Base" -> `find_best_service` with category, network `Base`, your need as `q`, and `prefer: cheapest`, then `get_service` on the top pick.
- "Is service X healthy?" -> `check_health` with `slug: X`.
- "Which x402 facilitators are real (have on-chain volume)?" -> `get_facilitator_volumes` with `timeframe: 30d`, then read each `verification` flag.
