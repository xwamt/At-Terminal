# P0b Acceptance — AT Series Hub adaptation (`at-terminal-series`)

Date: 2026-07-27  
Branch: `feature/p0a-mcp-hub`  
Repo: `C:\Users\alan\Desktop\at-terminal-series`

## Checklist

- [x] **ssh-plugins not modified by this work**  
  Evidence: All commits for this adaptation live only in `at-terminal-series`. This session did not edit files under `C:\Users\alan\Desktop\ssh-plugins`.  
  Snapshot at verification: ssh-plugins `main` @ `33cf895`; tracked dirty is only a pre-existing `package-lock.json` change (unrelated to this workstream).

- [x] **at-terminal-series own git, no old remote**  
  Evidence: `git remote` → empty (`NO_REMOTES`). Independent history starting at import commit `74737c1 chore: import AT Terminal snapshot for AT Series Hub adaptation`.

- [x] **no mcp-server.js product build**  
  Evidence after `npm run build:mcp`: `dist/` contains `extension.js` + `hub.js` (771188 bytes); **no** `dist/mcp-server.js`. `src/mcp/server.ts` absent. `esbuild` MCP variant has no per-plugin mcp-server entry (covered by `test/mcp/McpServerManifest.test.ts`).

- [x] **no languageModelTools in package.mcp.json**  
  Evidence: `package.mcp.json` → `contributes.languageModelTools` undefined / string search absent. Covered by `test/package.agent-tools.test.ts` and `test/package.variants.test.ts`.

- [x] **Bridge health/tools/invoke + series token**  
  Evidence: `test/mcp/BridgeServer.test.ts` (14 tests) — rejects missing/wrong series token (401), accepts `AT_SERIES_TOKEN_HEADER`, accepts legacy `x-at-terminal-token` during migration, serves `/health`, `/tools`, `/invoke`.

- [x] **registry under ~/.at-series/bridges**  
  Evidence: `test/mcp/bridgePublish.test.ts` publishes under `<home>/.at-series/bridges/<hostApp>/` and removes on dispose. (Live `~/.at-series/bridges` may be empty until an MCP extension host is activated.)

- [x] **installer AT Series + migrate + autoApprove excludes exec/write**  
  Evidence: `test/mcp/McpConfigInstaller.test.ts` — writes **AT Series**, migrates legacy `AT Terminal` away, keeps unrelated servers; `autoApprove` excludes `run_remote_command`.  
  Hub helper probe: `defaultAutoApproveToolNames({registryTools})` →  
  `["at_list_providers","list_ssh_servers","get_terminal_context","sftp_list_directory","sftp_stat_path","sftp_read_file"]`  
  — `excludes exec true`, `excludes write true`.

- [x] **AgentToolService auth tests still pass**  
  Evidence: `npm test -- test/agent` → **5 files, 26 tests passed** (includes `AgentToolService.test.ts` confirmation / background-auth cases).

- [x] **npm test + build:mcp green (paste counts)**  
  Fresh run 2026-07-27:

  ```text
  npm test
  Test Files  60 passed (60)
  Tests       306 passed (306)

  npm run build:mcp
  copied hub.js
  (exit 0)

  npm run typecheck
  (exit 0)
  ```

## Related commits (this branch tip at acceptance)

| SHA | Subject |
| --- | --- |
| *(this commit)* | `docs: record P0b acceptance checklist` |
| `da9ea9a687b13c8a26ef3442f5c630c966235f93` | `docs: document AT Series Hub adaptation for at-terminal-series` |
| `2d84b6ffe2428bf737368e9f52c49d149970c925` | `feat: wire AT Series hub sync, bridge publish, and MCP install on activate` |
| `ce7fe9da6bbc1710770c9db484880451526f4fad` | `feat: remove LM tools and per-plugin mcp-server entry` |

See also [ADR-005](../../decisions/ADR-005-at-series-hub-adaptation.md).

## DONE_WITH_CONCERNS

1. **ssh-plugins working tree** has a pre-existing dirty `package-lock.json` on `main` — not caused by this work, but the tree is not perfectly clean if someone audits the sibling repo casually.
2. **Live IDE bridge registry** (`~/.at-series/bridges`) was not exercised by launching a VS Code/Cursor extension host in this verification pass; coverage is unit/integration tests only.
