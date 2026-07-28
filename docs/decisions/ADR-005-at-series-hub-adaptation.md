# ADR-005: AT Series Hub adaptation for at-terminal-series

## Status
Accepted

## Date
2026-07-27

## Context

AT Terminal MCP historically lived in the `ssh-plugins` product line with a per-plugin stdio MCP entry (`dist/mcp-server.js`) and VS Code `languageModelTools`. The shared **AT Series MCP Hub** (Protocol v1) replaces that packaging model so multiple AT-family plugins share one IDE MCP entry and one hub process.

This repository (`at-terminal-series`) is the adapted product line for that hub migration.

## Decision

1. **Copied from `ssh-plugins`, original untouched.**  
   `at-terminal-series` was imported as an independent git history (no shared remote with `ssh-plugins`). Adaptation work happens only in this repo. The original `ssh-plugins` tree remains the untouched source product line.

2. **Consume `@at-series/mcp-hub` Protocol v1.**  
   Bridge HTTP exposes `health` / `tools` / `invoke`, authenticates with the series token header (legacy `x-at-terminal-token` accepted during migration), publishes registry records under `~/.at-series/bridges/<hostApp>/`, and syncs/elects packaged `dist/hub.js` into `~/.at-series/mcp/hub.js`.

3. **Remove LM tools and per-plugin mcp-server.**  
   Product MCP packaging no longer contributes `languageModelTools` and no longer builds or ships `dist/mcp-server.js`. IDE MCP clients install a single **AT Series** entry that runs `node ~/.at-series/mcp/hub.js`. Installer migration removes legacy per-plugin `AT Terminal` MCP entries. Default `autoApprove` includes only hub builtins and `read`-risk tools (excludes `exec` / `write`).

4. **Keep extension-host authority.**  
   `AgentToolService` remains the execution and confirmation authority (remote-command confirmations, SFTP write authorization, host-key trust).

## Related

- [ADR-001](ADR-001-dual-build-variants.md) — base vs MCP build variants (`hub.js` packaging)
- [ADR-002](ADR-002-mcp-bridge.md) — bridge security invariants (still in force)
- [ADR-003](ADR-003-agent-command-confirmation.md) — command confirmation policy
- [ADR-004](ADR-004-at-series-mcp-hub.md) — decision to adopt the shared hub protocol

Canonical hub protocol: `@at-series/mcp-hub` / AT Series Protocol v1.

## Consequences

- Agents and IDEs target **AT Series**, not a per-plugin MCP server binary.
- `ssh-plugins` can continue independently; this repo does not require modifying it to ship hub adaptation.
- Docs and installer copy must keep describing AT Series-only MCP entry and hub paths under `~/.at-series`.
