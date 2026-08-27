# Wiring notes — slice E (ux-docs)

Branch: `cursor/slice-e-ux-docs-9e2f` (based on `cursor/implement-optimizations-11f8` @ 453180c).
Everything below is either work for the integrator or a dependency on another slice.

## Implemented in this slice (for context)

- Host-key change recovery: `promptChangedHostKey` in `src/extension.ts` (persistent
  `showErrorMessage` with View Fingerprint / Trust New Key / Forget and Reconnect; change
  still blocks by default). New commands `sshManager.viewHostFingerprint` and
  `sshManager.forgetHostKey` (server context menu + palette with server QuickPick).
- Palette: `connect` / `editServer` / `deleteServer` / `copyHost` /
  `viewHostFingerprint` / `forgetHostKey` fall back to a server QuickPick;
  `disconnect` / `reconnect` show an information message when no terminal is active.
  Item-only SFTP commands (`download`, `delete`, `rename`, `edit`, `openPreview`,
  `cdToDirectory`, `copyPath`) are hidden from the palette via `menus.commandPalette`
  `when: "false"` in all three manifests.
- `showErrorWithActions` in `src/utils/notifications.ts`; hub-sync/config failures show a
  persistent error with a **Repair** action that runs `sshManager.installMcpConfig`;
  `runSftpCommand` failures use persistent `showErrorMessage`.
- `viewsWelcome` for `sshManager.servers` / `sshManager.sftpFiles` in all three manifests.
- MCP variant `displayName` is `%atTerminal.mcpDisplayName%` = "AT Terminal MCP".
- Every command has `"category": "AT Terminal"`. The MCP install/uninstall titles are now
  `Install/Repair MCP Config` / `Uninstall MCP Config`, so the palette shows
  `AT Terminal: Install/Repair MCP Config` and `AT Terminal: Uninstall MCP Config`.
- Limited-trust help copy rewritten (three lines matching `toolCatalog.ts` semantics) in
  `ServerFormPanel`, the webview fallback, `docs/features*.md`, and `README.md`.
  `webview/server-form/index.ts` no longer auto-toggles the background checkbox.
- Server tree shows connection state (`vm-active` + "Connected" suffix, or
  `debug-disconnect` for known-but-disconnected terminals) fed from
  `TerminalContextRegistry.getSnapshot()`; the tree refreshes on
  `onDidChangeContext` / `onDidRemoveContext`.
- Asset export password mismatch now surfaces an error with **Try Again** retry; import
  decryption failures are localized (`localizeAssetImportError`) with a retry loop.
- New settings declared in all three manifests: `sshManager.zebraStripes`
  (boolean, default `false`) and `sshManager.sessionLogDirectory` (string, default `""`),
  plus `%atTerminal.config.*%` descriptions for every existing setting.

## Integrator TODOs

1. **`onDidRemoveContext` → agent SFTP session cleanup.** In this worktree
   `SftpAgentService` only exposes a whole-service `dispose()` (already in
   `context.subscriptions`, so it runs on deactivate). There is no per-terminal
   `disposeSession(terminalId)` / `disposeServer(serverId)` yet — slice D introduces it.
   Once merged, add to the `terminalContext.onDidRemoveContext` handler in
   `src/extension.ts`:

   ```ts
   terminalContext.onDidRemoveContext((terminalId) => {
     sftpManager.removeTerminalContext(terminalId);
     treeProvider.refresh();
     sftpAgentService?.disposeSession(terminalId); // TODO: wire when slice D lands
   });
   ```

   Did not invent the API here per the contract.

2. **Skill docs still use the old command name.**
   `skills/at-terminal-mcp/references/setup.md` (slice D ownership) says
   `AT Terminal: Install MCP Config`; update to `AT Terminal: Install/Repair MCP Config`.
   `test/docs/AtTerminalMcpSkill.test.ts:74` asserts the old string — update both
   together (this slice deliberately left both untouched so the suite stays green).

3. **`.vscodeignore` for `docs/images`.** `scripts/package-variant.mjs` now stages
   `docs/images/` (when present), but `.vscodeignore` (not owned by this slice) still
   excludes everything under `docs/**` except `*.md` and `mcp/*.yaml`. Add
   `!docs/images/**` if the screenshots referenced by `README-base.md` should ship in the
   VSIX; otherwise the staged copy is inert.

4. **Settings behavior.** `sshManager.zebraStripes` and `sshManager.sessionLogDirectory`
   are contributed + localized here; slice C implements the runtime behavior (zebra
   default-off / WebGL exclusivity, session log side-write). Names match the contract.

5. **Remaining English outside this slice's ownership** (wrap with `t()` in the owning
   slice and add zh-cn bundle entries per the contract):
   - `src/sftp/TransferService.ts` — success/progress suffixes (e.g. "uploaded",
     "downloaded", verification messages) — slice B.
   - `src/agent/AgentToolService.ts` / `RemoteCommandExecutor.ts` — command confirmation
     dialog copy and error strings — slice D.
   - `src/webview/TerminalPanel.ts` / `webview/terminal/**` — structured status mapping
     and reconnect notices — slice C (contract already assigns `t()` for status text).
   - `src/ssh/SshSession.ts` — status strings — slice A (structured status per contract).

6. **Merge caution — `src/extension.ts`.** This slice reordered activation so
   `TerminalContextRegistry` is constructed before `ServerTreeProvider` (the provider now
   takes a connection-state callback). Slices must not construct their services before
   `terminalContext` exists.

7. **Removed l10n keys.** The obsolete bundle entries for the old 3-second host-key toast
   and the old limited-trust paragraph were deleted from `l10n/bundle.l10n.zh-cn.json`.
   If another slice still calls `t()` with those exact old strings, the nls test will
   flag it — use the new strings instead.
