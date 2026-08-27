# Wiring notes — slice C (terminal)

Snippets that belong to files owned by other slices (`package.json` contributes, `extension.ts`,
`l10n/bundle.l10n.zh-cn.json`). Slice C only added the two xterm addon dependencies to
`package.json`; everything below still needs to be wired by the owning slice / integrator.

## package.json — `contributes.configuration.properties`

The UX slice (E) owns contributes. Slice C reads these two settings in
`resolveTerminalSettings` (`src/webview/TerminalPanel.ts`) with the defaults shown, so the
extension works before the contributions land — they just will not appear in the Settings UI
until added:

```json
"sshManager.zebraStripes": {
  "type": "boolean",
  "default": false,
  "description": "%atTerminal.config.zebraStripes.description%"
},
"sshManager.sessionLogDirectory": {
  "type": "string",
  "default": "",
  "description": "%atTerminal.config.sessionLogDirectory.description%"
}
```

Suggested description copy:

- `zebraStripes`: "Alternate terminal row background stripes. Enabling this forces the slower
  DOM renderer; when disabled the terminal uses the WebGL renderer."
- `sessionLogDirectory`: "When set to a directory path, raw terminal output of every SSH
  session is appended to `<label>-<serverId>.log` inside it. Leave empty to disable."

Behavioral contract implemented in this slice:

- `zebraStripes` default **false**. When true the webview keeps the DOM renderer (zebra
  restyles DOM rows); when false it attaches `@xterm/addon-webgl` and falls back to the DOM
  renderer on load failure or GPU context loss (`webview/terminal/renderer.ts`).
- `sessionLogDirectory` empty string disables logging. Non-empty: `SessionLogWriter`
  (`src/webview/TerminalPanel.ts`) creates the directory, appends output bytes to
  `<sanitized-label>-<id>.log`, and silently disables itself on the first I/O failure.

## package.json — dependencies (already done in this slice)

- `@xterm/addon-webgl` `^0.18.0`
- `@xterm/addon-search` `^0.15.0`

Both are bundled into `dist/webview/terminal.js` by the existing esbuild webview config; no
build changes were needed.

## extension.ts

No changes required. Interfaces consumed by `extension.ts` are backward compatible:

- `TerminalPanel.reconnect()` gained an optional `{ auto?: boolean }` parameter; the existing
  `sshManager.reconnect` command call (`reconnect()`) still compiles and now also resets the
  auto-reconnect budget, which is the desired semantics for a user-initiated action.
- The webview additionally posts `{ type: 'reconnect' }` (Reconnect button) and
  `{ type: 'ack', bytes }` (flow control); both are handled inside `TerminalPanel` itself.

## src/ssh/SshSession.ts (slice A heads-up)

This slice added minimal `pauseOutput()` / `resumeOutput()` methods (shell stream
`pause()`/`resume()`) because they were not present in this worktree. If slice A lands its own
versions, either copy wins — `TerminalPanel` calls them through optional chaining
(`session.pauseOutput?.()`).

Status bridge: `TerminalPanel.normalizeSessionStatus` accepts **either** the current string
statuses (`'Connecting…'`, `'Connected'`, `'Disconnected'`, plus localized text containing
`已断开`) **or** slice A's structured `{ state: 'connecting' | 'connected' | 'disconnected', text }`
events, and always forwards a structured `{ state, text }` payload to the webview. Once slice A
emits structured statuses everywhere, the string branch in `normalizeSessionStatus` becomes
dead code and can be deleted.

Encoding: `resolveTerminalSettings` reads `server.encoding` (falls back to `utf-8`) and the
webview creates a streaming `TextDecoder` for `gbk` / `big5`. When slice A widens the schema
enum to `utf-8 | gbk | big5`, no terminal-side change is needed.

## l10n/bundle.l10n.zh-cn.json (UX slice owns the file)

> **Integrator note:** `test/i18n/nls.test.ts` ("has a zh-cn translation for every one") fails
> on this branch until the keys below are added to the bundle. The slice-C gates
> (`npx vitest run test/webview`, `npx tsc --noEmit`) are green; the nls test goes green once
> slice E merges these entries.

New `t()` strings introduced by this slice that need zh-cn entries:

| English key | Suggested zh-cn |
| --- | --- |
| `Reconnect` | `重新连接` |
| `Find` | `查找` |
| `Previous match` | `上一个匹配` |
| `Next match` | `下一个匹配` |
| `Close find` | `关闭查找` |
| `Connection lost. Reconnecting in {seconds} second(s) (attempt {attempt} of {max})...` | `连接已断开。将在 {seconds} 秒后重新连接（第 {attempt} 次，共 {max} 次）...` |
| `Automatic reconnect stopped after {max} attempt(s). Use the Reconnect button to retry.` | `自动重连已在 {max} 次尝试后停止。请点击“重新连接”按钮重试。` |
| `Reconnect stopped: host key verification failed.` | `重连已停止：主机密钥验证失败。` |

Already present in the bundle and reused: `Reconnecting...`, `Disconnected`,
`Connection disconnected`, `Disconnected after {minutes} minute(s) of inactivity.`,
`SSH: {label}`, `Starting...`.

## Webview protocol changes (for anyone touching the terminal webview)

- `outputBytes` payload is now a `Uint8Array` (binary structured clone), not base64. The
  batcher (`src/webview/TerminalOutputBatcher.ts`) emits standalone `Uint8Array`s.
- Host → webview `status` payload is `{ state, text }` (see status bridge above). The webview
  derives the status dot class and Reconnect button visibility from `state` only.
- Webview → host: `{ type: 'ack', bytes }` after each consumed chunk; host pauses the SSH
  stream above 512 KiB in flight and resumes below 128 KiB, with a 5 s dead-man timeout so a
  reloaded webview (lost acks) cannot leave the stream paused.
