# Implementation contract — parallel optimization slices

Target branch for final merge: `cursor/implement-optimizations-11f8` (never `main`).
Spec: `docs/handoffs/2026-08-27-optimization-recommendations.md`.

## Global rules

- Do not checkout, commit to, or push `main`.
- Stay inside your file-ownership list. If you need a change outside it, put a snippet in `docs/handoffs/_wiring-<slice>.md` instead of editing the foreign file.
- Keep existing tests green; add tests for new behavior.
- Every new `t('...')` string needs a matching key in `l10n/bundle.l10n.zh-cn.json` (only the UX slice owns that file — other slices use `t()` and list new English strings in `_wiring-*.md`).
- Do not implement: remote VS Code server, native Chat, FileSystemProvider workspace mount, tmux/Mosh/X11, SFTP bidirectional sync, exposing port-forward as an MCP tool, sharing one SSH connection across terminal/agent/SFTP.
- `sftp_delete` must never join a directory grant; full trust still prompts for delete.
- Host-key **change still blocks by default**. New actions are explicit user choices.

## Slice ownership

### A — ssh-auth (`src/ssh/**`, `src/config/**`, `test/ssh/**`, `test/config/**`)

- `authType` adds `'agent'`. Passphrase in SecretStorage (`sshManager.passphrase.<id>`), parallel to password.
- Encrypted key: pass `passphrase` into ssh2; if missing, callers may prompt (document the hook).
- `tryKeyboard: true`; `keyboard-interactive` → InputBox sequence; background/no-UI path errors clearly (do not hang).
- Lazy-load `ssh2` on first connect (`src/ssh/ssh2Loader.ts`).
- `SshSession`: structured status `{ state: 'connecting'|'connected'|'disconnected', text: string }`; `pauseOutput()` / `resumeOutput()` via shell pause/resume; i18n via `t()` for `text`.
- Encoding enum `utf-8 | gbk | big5` on schema (default utf-8).
- New modules + tests: `SshConfigImport.ts` (Host/HostName/User/Port/IdentityFile/ProxyJump; multi-hop truncated with notice); `LocalPortForward.ts` (local `-L` using existing `forwardOut`; not an MCP tool).
- Do not edit `src/extension.ts` or `package.json`.

### B — sftp (`src/sftp/**`, `src/tree/Sftp*.ts`, `test/sftp/**`, `test/tree/Sftp*.ts`)

- Recursive directory upload/download (concurrency 4, aggregated progress).
- Non-empty directory delete (list first; caller supplies confirmation — export entry count).
- Upload conflict: `stat` then return/throw a typed conflict the UI can map to overwrite/skip/all.
- Listing cache keyed `(terminalId, path)`, TTL 15–30s; invalidate on mutating ops; `refresh(node)` not always full tree.
- Skip SFTP tree refresh when switching back to the same terminalId+rootPath.
- File click command `sshManager.sftp.openPreview`; tooltip says edit uploads on save. Symlink-to-dir remains expandable.
- `readFile(path, maxBytes, offset?)` — negative offset from end. Sliding window 4–8 in-flight for read/writeBuffer.
- Transfer reporter throttle ≥100ms or percent change. Tiny ops (mkdir/rename/delete) do not success-toast.
- `verifyUploadedContent`: `fs.stat` size first; full read only if ≤256KB compare path.
- Do not edit `src/extension.ts`.

### C — terminal (`webview/terminal/**`, `src/webview/TerminalOutputBatcher.ts`, `src/webview/TerminalPanel.ts`, `test/webview/Terminal*.ts`)

- `@xterm/addon-webgl` with DOM fallback; zebra setting default off (DOM+zebra only when on); remove `allowTransparency` unless background has alpha.
- Flow control: webview `term.write(..., cb)` → `{type:'ack', bytes}`; host high-water 512KiB pause / 128KiB resume (call `pauseOutput`/`resumeOutput` if present).
- `outputBytes` as `Uint8Array` (no base64). Update tests.
- Disconnect UI: Reconnect button; auto-reconnect exponential backoff max 3, always through existing hostKeyVerifier; user-initiated disconnect does not auto-reconnect.
- `@xterm/addon-search` find bar. Optional `sshManager.sessionLogDirectory` side-write of output.
- Encoding: `TextDecoder(encoding, {stream:true})` from settings/server encoding.
- Structured status class from `state`, never English substring match. Reconnect notice uses `t()`.
- You may `npm install` `@xterm/addon-webgl` and `@xterm/addon-search`. Prefer not to rewrite unrelated `package.json` contributes.
- Do not edit `src/extension.ts`.

### D — agent-mcp (`src/agent/**`, `src/mcp/**`, `test/agent/**`, `test/mcp/**`, `skills/at-terminal-mcp/**`)

- Background SFTP when `backgroundConnectionAllowed` (reuse `resolveServer` semantics); `allowSudoFallback: false`; pool by serverId with 5min idle TTL like `RemoteCommandExecutor`.
- `disposeSession(terminalId)` / `disposeServer(serverId)`; document that `extension.ts` must call this from `onDidRemoveContext`.
- `sftp_read_file` `offset` (negative = tail); `sftp_list_directory` `offset` pagination. Update schemas, catalog, skill, tests.
- `sftp_rename` (both paths through write authorizer). `sftp_delete` files only, always confirm, never directory-grant, not skipped by full trust.
- `run_remote_command` confirm timeout 120s → actionable error. Keep captured stderr on command timeout (`timedOut` already set).
- Background-denied error tells user to enable Allow background connections on the server form.
- Agent audit: OutputChannel + JSONL under globalStorage; redact via `redactSensitiveText`; include reasonCode.
- Hub sync fast path: version + size/mtime skip; full hash on mismatch/Repair.
- Do not edit `src/extension.ts`.

### E — ux-docs (`src/extension.ts`, `package.json`, `package.base.json`, `package.mcp.json`, `package.nls*`, `l10n/**`, `src/i18n/**`, `src/utils/notifications.ts`, `src/webview/ServerFormPanel.ts`, `webview/server-form/**`, `src/tree/TreeItems.ts`, `src/tree/ServerTreeProvider.ts`, `src/assets/AssetCommands.ts`, `docs/**`, `README*`, `scripts/package-variant.mjs`, `test/docs/**`, `test/i18n/**`, `test/package*.ts`, `test/extension/**`, `test/utils/notifications.test.ts`, `test/webview/ServerForm*`)

- Host-key changed: persistent `showErrorMessage` with View fingerprint / Trust new key / Forget and reconnect. Commands `sshManager.viewHostFingerprint`, `sshManager.forgetHostKey` on server context menu. Default remains block.
- Command palette: no silent `if (!item) return`. QuickPick servers/files, or hide pure-context commands via `commandPalette` `when`.
- Errors: `showErrorMessage` + actions; timed toasts only for success. Hub sync failure includes Repair button running `sshManager.installMcpConfig`.
- `viewsWelcome` for empty Servers and SFTP Files.
- MCP `displayName` distinct (`%atTerminal.mcpDisplayName%` = "AT Terminal MCP"). Update `test/package.variants.test.ts`.
- Commands: `"category": "AT Terminal"`; MCP install title `AT Terminal: Install/Repair MCP Config`. Sync `test/docs/McpDocs.test.ts`.
- Limited-trust help: three-line copy matching **code** (unknown commands run without prompt on limited/full). Fix `docs/features*.md` to match code, not the reverse. Do not auto-toggle background checkbox when trust changes.
- Server tree: connected icon/description from `TerminalContextRegistry`.
- i18n: wrap remaining host-visible English listed in the UX review; structured status if `SshSession` still sends strings, map in TerminalPanel only if you own that file — otherwise list leftovers in `_wiring-ux.md`.
- Asset export: password mismatch message + retry. Import error localized.
- Copy `docs/images/` in `scripts/package-variant.mjs`. Fix Feishu URL, version numbers, duplicate capability table, `idleDisconnectMinutes` in usage, rz/sz claims (remove until implemented), folder-download claim (keep if slice B implements it — say "directory download supported").
- Settings descriptions via `%atTerminal.config.*.description%`. `sshManager.zebraStripes` default false; `sshManager.sessionLogDirectory` optional string.
- Notification noise: mkdir/rename/delete success silent if TransferService still toasts — gate in extension command wrappers if needed.

## After slices land

Integrator merges A–E into `cursor/implement-optimizations-11f8`, wires `_wiring-*.md` into `extension.ts`, runs `npm test` and `npm run typecheck`.
