# Changelog

All notable changes to `x402-list-mcp` are recorded here. This project follows semantic
versioning: while the major version is 0, a minor bump may carry a breaking change.

## 0.5.3 - 2026-10-10

### Changed: service traction fields

- `x402_get_service` field notes describe `volume_usd_30d` as a rolling 30-day window ending when the snapshot was computed, not 30 UTC days.
- `assessment.traction` now carries `top_3_buyers_share_30d` and `concentrated_volume`, passed through from the API and described in the field notes.
- `x402_get_service` notes explain that `concentrated_volume` can be null on a measured snapshot when the top 3 share is not available yet and the volume and settlement minimums are met.
- `x402_find_best_service` notes describe the rolling 30-day traction window and the linear top-buyer discount with no threshold.

## 0.5.2 - 2026-10-07

### Fixed: catalog descriptions

Removed fixed catalog counts from the server instructions and the search and health tool descriptions.

### Documentation and package metadata

- Added hosted and local Claude Code installation commands, a Cursor install link and remote configuration, and VS Code and Codex connection examples.
- Linked the public source repository and Glama badge, and made ranking guidance refer to the returned `ranking_version`.
- Moved the 0.4.x upgrade notice below, alongside the 0.5.0 breaking-change details.
- Added npm keywords: `directory`, `discovery`, `trust`, `uptime`, `agent`.

## 0.5.1 - 2026-09-01

### Added: tool titles and annotations

All seven tools now declare a human-readable `title` and tool annotations. The six read-only
tools carry `readOnlyHint: true`; the paid `x402_assess_services` carries `readOnlyHint: false`.
Nothing else changed: same names, same parameters, same response shapes, same semantics.

## 0.5.0 - 2026-08-21

> **Upgrading from 0.4.x? Every tool was renamed.** 0.5.0 moved all of them into the `x402_*` namespace
> and removed the old names, with no compatibility aliases: a `tools/call` for `get_service` or
> `search_x402_services` now comes back as a JSON-RPC `-32602` "Tool not found", and the old names are
> absent from `tools/list` too. The old-to-new table and the upgrade checklist (prompts, client
> allow lists, eval fixtures) are below.

### BREAKING: every tool was renamed into the `x402_*` namespace

All six tools that shipped in 0.4.x now answer under a new name. **The old names no longer
exist.** A `tools/call` for any of them is answered with a JSON-RPC error (`-32602`,
`Tool <name> not found`), and they do not appear in `tools/list` either. Nothing else about
the tools changed in this release: same parameters,
same response shapes, same semantics.

| Old name (0.4.x, removed) | New name (0.5.0) |
| --- | --- |
| `search_x402_services` | `x402_search_services` |
| `get_service` | `x402_get_service` |
| `find_best_service` | `x402_find_best_service` |
| `check_health` | `x402_check_health` |
| `get_facilitator_volumes` | `x402_facilitator_volumes` |
| `assess_services` | `x402_assess_services` |

### There are no compatibility aliases, on purpose

The old names were not kept as deprecated aliases. Two reasons, both deliberate:

1. **One surface to maintain.** Aliases double the number of registered tools, and every one
   of them has to keep its schema, its description and its tests in step with the real tool
   for as long as the alias lives. Two names for one behaviour is two places to get wrong.
2. **The model's context budget is the scarce resource.** Every registered tool spends tokens
   in the agent's preamble before a single question is asked, and a deprecated duplicate spends
   them twice over while also forcing a paragraph of "prefer the new name" guidance. Keeping the
   aliases would have made the preamble worse in exactly the dimension this release is trying to
   improve.

Breaking now is cheap and it will never be cheaper: the installed base is small, and a clean
namespace is what makes the tools legible next to the other MCP servers an agent has loaded.

### What you need to do to upgrade

Search your setup for the six old names and replace them with the new ones, everywhere they are
written down by hand:

- system prompts, skill files and agent instructions that name a tool ("call `get_service`
  after `search_x402_services`");
- code that calls tools programmatically, for example `client.callTool({ name: "check_health" })`;
- allow lists, deny lists and per-tool permission rules in your MCP client configuration, which
  match on the tool name and will silently stop matching;
- evaluation fixtures and transcripts that assert on tool names.

Nothing needs to change in your MCP server configuration itself: the package name, the binary,
the environment variables and the hosted endpoint are all unchanged.

### Added: a seventh tool, `x402_change_events`

A read-only, free feed of the changes x402-list observes on listed services over time: a service
moving its payout address, changing an endpoint price, or altering its 402 schema. Filter by
`service` (a listing slug), by `type` (one of `payto_changed`, `price_changed`, `schema_changed`),
and by `days`; page through with `page` and `per_page`. Each event carries the observation
timestamp, a summary, and the before and after snapshots. Payout addresses are returned masked by
the API, as they are on the website.

Use it to answer "has this service changed under me since I last looked", which is the question
a static listing cannot answer.
