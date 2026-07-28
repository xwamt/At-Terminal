# ADR-004: Adopt AT Series shared MCP Hub (Protocol v1)

## Status
Accepted (implemented for product packaging: languageModelTools and per-plugin mcp-server entry removed)

## Date
2026-07-23

## Context

ADR-002 established per-extension MCP stdio + localhost Bridge. With multiple AT-family plugins, that multiplies MCP processes and IDE config entries.

## Decision

AT Terminal MCP will migrate to the shared **AT Series Hub** protocol:

- Canonical package / protocol: [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) (Protocol v1)
- Package: `@at-series/mcp-hub` (hub runtime, installers, and protocol types)

Local consequences for this repo when implemented:

- Replace per-tool Bridge routes with `health` / `tools` / `invoke`
- Publish registry under `~/.at-series/bridges/<hostApp>/`
- Remove product `languageModelTools` surface
- Remove primary per-plugin `mcp-server.js` IDE entry in favor of `AT Series`
- Keep extension-host `AgentToolService` as execution authority

## Consequences

- This ADR supersedes the *product packaging* implication of "one MCP server per plugin" from ADR-002
- ADR-002 security invariants (credentials in extension host, confirmations, host key checks) remain in force

Adaptation record for this repository: [ADR-005](ADR-005-at-series-hub-adaptation.md).

