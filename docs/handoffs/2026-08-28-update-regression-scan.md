# 2026-08-28 — Update regression scan (main → cursor/implement-optimizations-11f8 @ aaa1ff9)

Scope: model-quality read of the full diff from `origin/main` to this branch, focused on
regressions the update itself introduced — activation, MCP bridge, terminal context, SFTP
wiring, schema/storage, packaging, i18n, host-key handling, and settings defaults. Ancient
backlog items (chmod semantics, port-forward UX polish, GBK input path) were out of scope.

Branch: `cursor/scan-regressions-11f8`. All 748 tests pass (`npx vitest run`), including the
new coverage added here. Owned files (`src/extension.ts`, `src/config/ConfigManager.ts`,
`src/agent/AgentToolService.ts`, `src/mcp/BridgeServer.ts`, `src/mcp/toolCatalog.ts`,
`src/webview/TerminalPanel.ts`) were not edited; bugs found there are documented below with
suggested patches.

---

## 1. Confirmed bugs fixed on this branch

### 1.1 Drag-and-drop upload fails silently on a name conflict — HIGH (fixed)

`SftpSession.uploadFile` now raises `SftpConflictError` when the remote name already exists
(new default: never overwrite silently), and `TransferService` deliberately suppresses the
failure toast for conflicts because "the caller maps it to an overwrite/skip prompt". The
`sshManager.sftp.upload` command got that prompt; `SftpDragAndDropController.handleDrop` did
not. Result: dropping a file onto the SFTP tree where the name exists did **nothing** — no
upload, no prompt, no toast (VS Code swallows a rejected `handleDrop`). On `main` the same
drop overwrote the remote file, so this is a new silent dead end.

Fix: `src/sftp/SftpDragAndDropController.ts` now catches the conflict and shows the same
modal Overwrite / Overwrite All / Skip prompt as the upload command, retrying with
`{ overwrite: true }` on approval and remembering Overwrite All across a multi-file drop.
Non-conflict errors still propagate. Covered by four new tests in
`test/sftp/SftpDragAndDropController.test.ts`.

### 1.2 Explicit SFTP Refresh can serve a 20-second-stale listing — MEDIUM (mechanism fixed; one-line wiring left, owned file)

This branch added a per-terminal listing cache (`LISTING_CACHE_TTL_MS = 20s`) to
`SftpManager.listDirectory`. Mutations through the extension invalidate correctly, but the
explicit refresh button (`sshManager.sftp.refresh` → `sftpTreeProvider.refresh()`) re-lists
through the cache, so a user who clicks Refresh to see changes made *outside* the extension
(another SSH session, cron) can still see stale data for up to 20 s. On `main`, Refresh always
hit the server — that guarantee is the button's whole purpose.

Fixed here: `SftpManager.invalidateAllListings()` (public, tested in
`test/sftp/SftpManager.test.ts`). The remaining wiring is one line in the owned
`src/extension.ts` refresh handler:

```ts
vscode.commands.registerCommand('sshManager.sftp.refresh', () => {
  sftpManager.invalidateAllListings();
  sftpTreeProvider.refresh();
}),
```

---

## 2. Confirmed bugs I could not fix (file ownership)

### 2.1 `ConfigManager.listServers` persist-on-read permanently deletes unmigratable records — MEDIUM-HIGH (data loss), owner: `src/config/ConfigManager.ts`

The new read path is forgiving: `parseServerConfigList` migrates each record and *drops*
entries that still fail (`migrateServerConfig` → `undefined`). That part is fine — one corrupt
record no longer hides every server. But `listServers()` then writes the filtered list back:

```ts
if (JSON.stringify(servers) !== JSON.stringify(raw)) {
  await this.globalState.update(SERVERS_KEY, servers);
}
```

A record that fails migration (e.g. a field corrupted to the wrong type, or a record written
by a **newer** extension version with a shape this version rejects) is deleted from
`globalState` on the very first read — permanently, including after a downgrade/rollback. On
`main` a bad record made the parse throw: ugly, but the data stayed on disk. The comment says
the write-back exists to persist "a backfilled encoding", i.e. lossless canonicalisation;
deleting rows was not the intent.

Suggested patch (persist only lossless migrations):

```ts
async listServers(): Promise<ServerConfig[]> {
  const raw = this.globalState.get<unknown[]>(SERVERS_KEY, []);
  const servers = parseServerConfigList(raw);
  // Persist the canonical shape only when every raw record survived migration.
  // If any entry was dropped (corrupt, or written by a newer version), leave the
  // raw data on disk: a read must never permanently delete a server record.
  if (servers.length === raw.length && JSON.stringify(servers) !== JSON.stringify(raw)) {
    await this.globalState.update(SERVERS_KEY, servers);
  }
  return servers;
}
```

Suggested test (`test/config/ConfigManager.test.ts`):

```ts
it('does not write back when a record fails migration, so the raw data survives', async () => {
  const good = validServerRecord({ id: 'a' });
  const corrupt = { ...validServerRecord({ id: 'b' }), keepAliveInterval: 'thirty' };
  const globalState = mementoWith({ 'sshManager.servers': [good, corrupt] });
  const manager = new ConfigManager(globalState, secretsStub());

  const servers = await manager.listServers();

  expect(servers.map((s) => s.id)).toEqual(['a']);       // corrupt row hidden from the UI…
  expect(globalState.get('sshManager.servers', [])).toHaveLength(2); // …but not deleted from disk
});
```

### 2.2 Recursive-delete confirmation overstates for symlinked directories — LOW, owner: `src/extension.ts`

`sshManager.sftp.delete` shows "{count} entries will be permanently deleted" when
`entry.type === 'directory' || entry.targetType === 'directory'`, and
`countDeletableEntries(entry.path)` counts *through* the symlink (server-side readdir follows
it). But `SftpManager.deleteEntry` for a `symlink` entry calls `deleteFile`, which unlinks
just the link. The action is safe; the message threatens to delete N entries that will in
fact survive. Suggested fix: only compute the count when `entry.type === 'directory'`, and
use the plain "Delete remote {type}" message for symlinks.

### 2.3 Command-confirmation timeout discards a late approval — LOW-MEDIUM, owner: `src/agent/AgentToolService.ts`

`runRemoteCommand` now races the modal against a 120 s timeout (good — the bridge no longer
hangs forever). But VS Code modals cannot be programmatically dismissed: after the timeout
fires, the dialog stays on screen, and a user who clicks "Run Command" at second 121 sees
nothing happen — their approval is silently discarded while the agent was already told to
"ask the user to approve … then retry". If the agent retries, a *second* dialog stacks on the
first. Suggested improvement: when the late answer arrives after the timeout, show a toast
("The approval arrived after the request timed out — the command was not run; ask the agent
to retry.") so the user isn't left believing the command ran.

---

## 3. Leftover risks (reviewed, no action taken)

- **Hub-sync fast path weakens tamper repair.** `@at-series/mcp-hub`'s `syncHubBundle`
  deliberately re-hashes `hub.js` on every sync so a tampered bundle is healed at activation.
  The new fast path (`src/mcp/hubSync.ts`) skips the sha256 when `hub-version.json` and the
  file's size+mtime match the recorded state — a same-size, mtime-preserving swap of `hub.js`
  now survives activation until a version changes or the user runs Repair (which forces the
  full sync). Judged acceptable (an attacker with that much filesystem control can also
  rewrite `hub-version.json`), but it is a real change in the security posture of the sync.
  Also, a plugin-only update (same packaged hub version) skips re-registering
  `writtenByPluginVersion` provenance; cosmetic.
- **`SftpSession.readFile` now trusts fstat size.** Reads are bounded by `fstat` and return
  empty for files that report size 0 but stream content (procfs over SFTP). Unreachable
  through current callers — agent reads and edit-verify already bound by `stat.size` (same as
  main), preview uses `downloadFile` — but a footgun for future callers of
  `SftpManager.readFile`.
- **SFTP sessions cannot answer keyboard-interactive prompts.** `SftpSession.connect`
  hardcodes `attachKeyboardInteractive(client, undefined, reject)`, so a 2FA
  (keyboard-interactive) server now works in the terminal but fails the SFTP panel with "no
  interactive prompt is available in this context". Not a regression versus `main`
  (`tryKeyboard` was previously off, so auth failed there too) but now visibly inconsistent
  with the terminal; the slice-E wiring notes already list "inject the prompt into the
  SftpManager session factory" as pending. Fixing it end-to-end needs the owned
  `src/extension.ts` (pass `createVscodeKeyboardInteractivePrompt()` through the SftpManager
  session factory) plus a prompt parameter on `SftpSession`.
- **Exact-string cancel mapping in the bridge.** `USER_CANCELLED_MESSAGES` in
  `src/mcp/BridgeServer.ts` (owned) matches three literal messages; a cancelled
  keyboard-interactive prompt ("Keyboard-interactive authentication was cancelled.") maps to
  a 500 instead of 499 USER_CANCELLED. Cosmetic today; brittle if any message is ever
  localized or reworded.
- **Zebra stripes default changed (known).** Row striping was unconditionally applied on
  `main`; it is now behind `sshManager.zebraStripes`, default **off**, and enabling it forces
  the DOM renderer instead of WebGL. Intentional per the optimization plan — just note that
  users who liked the stripes lose them silently on update.
- **Uploads no longer overwrite silently.** All upload paths (command, drag-drop, edit-save)
  now conflict-check first. Edit-save correctly pins `{ overwrite: true }`; the command and
  (after fix 1.1) drag-drop prompt. Behavior change by design, listed here for release notes.
- **Binary webview payloads.** Terminal output now crosses `postMessage` as `Uint8Array`
  (structured clone) instead of base64. Requires VS Code ≥ 1.57; `engines` is `^1.85.0`, so
  fine — flagged only in case the engines floor is ever lowered.

## 4. Verified-clean areas (for the record)

- Activation wiring: every command referenced by tree items/menus (`sftp.openPreview` etc.)
  is registered and present in all three package manifests; `TerminalContextRegistry.getSnapshot`
  and `SftpManager.getActiveViewDescriptor` wiring is consistent; agent session disposal is
  hooked to `onDidRemoveContext`/server edit/delete.
- MCP bridge: `sftp_rename`/`sftp_delete` dispatch, offset paging schemas, and the
  cancel-message set match what `SftpWriteAuthorizer`/`AgentToolService` actually throw.
- Schema/storage: `migrateServerConfig` correctly backfills `encoding`/`keepAliveInterval`
  and strips unknown keys; asset-package import applies the same migration per entry.
- i18n: all new `t()` strings exist in `l10n/bundle.l10n.zh-cn.json`; `package.nls.json` and
  `package.nls.zh-cn.json` cover the new command/config keys (enforced by `test/i18n` and
  `test/package.variants`).
- Host-key: the changed-key recovery prompt never auto-trusts; auto-reconnect stops on host
  verification failures instead of re-prompting.
