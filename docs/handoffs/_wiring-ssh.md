# Wiring notes — slice A (ssh-auth)

Branch: `cursor/slice-a-ssh-auth-8836`. Everything below is work that lives **outside**
slice A's file ownership (`src/ssh/**`, `src/config/**`, `test/ssh/**`, `test/config/**`)
and must be wired by the owning slice or the integrator.

## Files changed by this slice

Modified:

- `src/config/schema.ts` — `authType` adds `'agent'`; `encoding` is now `z.enum(['utf-8','gbk','big5']).default('utf-8')` (old configs without the field parse as `utf-8`).
- `src/config/ConfigManager.ts` — passphrase secret `sshManager.passphrase.<id>`: `getPassphrase(id)`, `passphraseKey(id)`, `saveServer(server, password?, passphrase?)`, deleted in `deleteServer`.
- `src/ssh/SshConnectionConfig.ts` — `tryKeyboard: true`; `authType 'agent'` → ssh2 `agent` from `resolveAgentSocket()` (`SSH_AUTH_SOCK`, or `\\.\pipe\openssh-ssh-agent` on win32, else clear error); private key auth passes `passphrase` from `PasswordProvider.getPassphrase?.(id)`; `buildSshConnectionHandle` gained optional `options: { keyboardInteractivePrompt? }` (4th arg) and attaches the keyboard-interactive helper to the jump-host client; jump client is built via the lazy loader.
- `src/ssh/SshSession.ts` — structured status events (see below), `pauseOutput()`/`resumeOutput()` (safe with no shell), optional 5th constructor arg `keyboardInteractivePrompt`, lazy ssh2.
- `src/ssh/SshConnectionTester.ts` — optional 5th arg `keyboardInteractivePrompt`, attaches the helper, lazy ssh2.
- `src/ssh/HostKeyStore.ts` — new exported `formatFingerprint(fingerprint)` and instance `describe(host, port)` for the host-key commands.
- `src/sftp/SftpSession.ts`, `src/agent/RemoteCommandExecutor.ts` — **minimal permitted edit only**: `import { Client } from 'ssh2'` → type-only import + `new (await getSsh2()).Client()`.
- Tests: `test/config/schema.test.ts`, `test/config/ConfigManager.test.ts`, `test/ssh/SshConnectionConfig.test.ts`, `test/ssh/SshConnectionTester.test.ts`, `test/ssh/SshSession.test.ts`, `test/ssh/HostKeyStore.test.ts`.

New:

- `src/ssh/ssh2Loader.ts` — `getSsh2()` caches a lazy `import('ssh2')` (esbuild compiles it to a lazy `require`; ssh2 is external). Pre-warms the cache only under `process.env.VITEST` so microtask-only test flushes stay deterministic.
- `src/ssh/KeyboardInteractive.ts` — pure `KeyboardInteractivePrompt` callback type + `attachKeyboardInteractive(client, prompt, onAbort)`. Missing prompt or cancel → `onAbort(clear Error)` + `client.end()`; never hangs.
- `src/ssh/VscodeKeyboardInteractivePrompt.ts` — `createVscodeKeyboardInteractivePrompt()` InputBox adapter (masked input when `echo` is false, `ignoreFocusOut`).
- `src/ssh/SshConfigImport.ts` — `parseSshConfig(content, { homeDir? })` → `{ entries, warnings }`; entries carry `alias`, a partial-`ServerConfig` `draft` (label/host/port/username/authType/privateKeyPath), and the first `proxyJump` hop. Wildcard/negated patterns skipped; multi-hop ProxyJump truncated to hop 1 with a warning; `~` in IdentityFile expanded; no network.
- `src/ssh/LocalPortForward.ts` — `new LocalPortForward(client, { remoteHost, remotePort, localPort?, localHost? })`; `start()` resolves the bound port, `stop()` closes listener + active tunnels. Deliberately **not** an MCP tool.
- Tests: `test/ssh/ssh2Loader.test.ts`, `test/ssh/KeyboardInteractive.test.ts`, `test/ssh/SshConfigImport.test.ts`, `test/ssh/LocalPortForward.test.ts`.

## New `t()` English source strings (slice E: add to `l10n/bundle.l10n.zh-cn.json`)

- `Connecting to {host}:{port}...`
- `Connected`
- `Disconnected` (already in the bundle — listed for completeness)
- `Keyboard-interactive authentication`
- `Authentication response`

`test/i18n/nls.test.ts` fails on this branch until the first, second, fourth and fifth
keys land in the bundle. Suggested translations: `正在连接 {host}:{port}...`,
`已连接`, `键盘交互认证`, `认证响应`.

## Known cross-slice seams on this branch

1. `npx tsc --noEmit` reports exactly one error: `src/webview/TerminalPanel.ts(217)` —
   the structured status event (slice C owns that file; patch below).
2. `test/i18n/nls.test.ts` — missing zh-cn keys (slice E; list above).
Everything else (`npx vitest run` 546/547, all of `test/ssh` + `test/config`) is green.

## Slice C — TerminalPanel structured status (fixes the tsc error)

`SshSessionEvents.status` now emits `{ state: 'connecting' | 'connected' | 'disconnected'; text: string }`
(`SshSessionStatus`, exported from `src/ssh/SshSession.ts`). Patch `TerminalPanel`:

```ts
import { SshSession, type SshSessionStatus } from '../ssh/SshSession';

// createSession():
status: (status) => this.handleSessionStatus(status, generation),

private handleSessionStatus(status: SshSessionStatus, generation: number): void {
  if (status.state === 'disconnected' && generation === this.connectionGeneration) {
    this.connected = false;
    this.terminalContext?.markDisconnected(this.terminalId);
    this.clearIdleDisconnect();
    this.postTerminalNotice(t('Connection disconnected'));
  }
  // Slice C: prefer posting the whole object so the webview classifies by `state`
  // instead of matching English substrings.
  this.postWebviewMessage({ type: 'status', payload: status });
}
```

Flow control: `SshSession` now has `pauseOutput()` / `resumeOutput()` for the
high-water/low-water ack protocol; both are safe to call in any state.

## extension.ts — keyboard-interactive prompt injection

`TerminalPanel` (slice C file) should construct its session with the prompt; the
adapter comes from slice A:

```ts
import { createVscodeKeyboardInteractivePrompt } from './ssh/VscodeKeyboardInteractivePrompt';

// wherever SshSession is constructed (TerminalPanel.createSession):
new SshSession(server, configManager, events, hostKeyVerifier, createVscodeKeyboardInteractivePrompt());
```

Background paths (`SftpAgentService` background sessions, `RemoteCommandExecutor`)
must NOT pass a prompt — the connection then fails with
`The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.`
instead of popping UI or hanging.

## ServerFormPanel (slice E) — passphrase + agent auth + test connection

- Add `'agent'` to the auth type selector; hide both password and key-path fields for it.
- Add an optional passphrase field for `privateKey` auth; pass it through:

```ts
await configManager.saveServer(server, password, passphrase);
```

- Connection test: forward the form passphrase and the prompt so encrypted keys and
  2FA work during Test Connection:

```ts
testSshConnection(
  candidate,
  {
    getPassword: async () => candidatePassword,
    getPassphrase: async () => candidatePassphrase ?? (existing ? configManager.getPassphrase(existing.id) : undefined),
    getServer: (id) => configManager.getServer(id)
  },
  requireHostKeyVerifier(options.hostKeyVerifier),
  undefined,
  createVscodeKeyboardInteractivePrompt()
);
```

- `src/tree/TreeItems.ts` shows `server.authType === 'privateKey' ? 'Private Key' : 'Password'`;
  agent servers currently display as "Password" — add an `SSH Agent` label.

## Host key commands (slice E) — `sshManager.viewHostFingerprint` / `sshManager.forgetHostKey`

```ts
import { formatFingerprint } from './ssh/HostKeyStore';

vscode.commands.registerCommand('sshManager.viewHostFingerprint', async (item?: ServerTreeItem) => {
  const server = item?.server ?? (await pickServer());
  if (!server) return;
  const description = hostKeyStore.describe(server.host, server.port);
  if (!description) {
    void vscode.window.showInformationMessage(t('No trusted host key stored for {host}:{port}.', { host: server.host, port: server.port }));
    return;
  }
  const copy = t('Copy fingerprint');
  const answer = await vscode.window.showInformationMessage(description, copy);
  if (answer === copy) {
    await vscode.env.clipboard.writeText(formatFingerprint(hostKeyStore.getTrusted(server.host, server.port)!.fingerprint));
  }
});

vscode.commands.registerCommand('sshManager.forgetHostKey', async (item?: ServerTreeItem) => {
  const server = item?.server ?? (await pickServer());
  if (!server) return;
  await hostKeyStore.forget(server.host, server.port);
  void vscode.window.showInformationMessage(t('Forgot the trusted host key for {host}:{port}.', { host: server.host, port: server.port }));
});
```

(Slice E owns the command copy and its l10n keys; host-key change still blocks by default.)

## SSH config import (slice E command; parser is slice A)

```ts
import { parseSshConfig } from './ssh/SshConfigImport';

const content = await fs.readFile(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
const { entries, warnings } = parseSshConfig(content);
for (const entry of entries) {
  const now = Date.now();
  await configManager.saveServer({
    id: randomUUID(),
    label: entry.draft.label,
    host: entry.draft.host,
    port: entry.draft.port,
    username: entry.draft.username ?? os.userInfo().username,
    authType: entry.draft.authType,
    privateKeyPath: entry.draft.privateKeyPath,
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: now,
    updatedAt: now
  });
  // entry.proxyJump: resolve to a saved server's id and set jumpHostId, or import the
  // hop first. Surface `warnings` (multi-hop truncation etc.) in the summary toast.
}
```

Drafts intentionally exclude `id`/timestamps; the caller generates them. Global
`Host *` defaults are not merged into concrete hosts.

## Local port forward (UI command sample; NOT an MCP tool)

```ts
import { LocalPortForward } from './ssh/LocalPortForward';
import { buildSshConnectionHandle } from './ssh/SshConnectionConfig';

const handle = await buildSshConnectionHandle(server, configManager, hostKeyVerifier, {
  keyboardInteractivePrompt: createVscodeKeyboardInteractivePrompt()
});
const { Client } = await getSsh2();
const client = new Client();
await new Promise<void>((resolve, reject) => {
  client.once('ready', resolve);
  client.once('error', reject);
  attachKeyboardInteractive(client, prompt, reject);
  client.connect(handle.config);
});
const forward = new LocalPortForward(client, { remoteHost: '127.0.0.1', remotePort: 5432, localPort: 15432 });
const boundPort = await forward.start();
// on command "stop": await forward.stop(); client.end(); handle.dispose();
```

## Slice B / D — keyboard-interactive on background connects (optional hardening)

`SftpSession` and `RemoteCommandExecutor` connect with `tryKeyboard: true` but attach no
listener (slice A was only allowed the import swap there). A keyboard-interactive-only
server therefore fails at ssh2's ready timeout (~20s, "Timed out while waiting for
handshake") instead of immediately. To fail fast with the clear error, wrap their
connect promises:

```ts
import { attachKeyboardInteractive } from '../ssh/KeyboardInteractive';

await new Promise<void>((resolve, reject) => {
  client.once('ready', resolve);
  client.once('error', reject);
  attachKeyboardInteractive(client, undefined, reject); // background: no prompt, clear error
  client.connect(handle.config);
});
```

Note for slice B: `KeyboardInteractiveClient.on` is optional specifically because the
base `test/sftp/SftpSession.test.ts` jump-host mock lacks `.on`; add `on` to that mock
(same shape as `once`) so the jump-host keyboard-interactive path is actually exercised.

## Behavior notes

- Passphrase flows automatically everywhere `ConfigManager` is the provider
  (`SshSession`, `SftpSession`, `RemoteCommandExecutor`, jump hosts) because
  `ConfigManager` now implements `PasswordProvider.getPassphrase`.
- "Encrypted key + missing passphrase" is not special-cased: ssh2 rejects with its own
  parse error; the optional prompt-and-retry loop belongs to the caller (slice E form
  or a reconnect flow) via `saveServer(server, undefined, passphrase)`.
- `sshManager.passphrase.<id>` never appears in exported assets; `AssetExportService`
  only reads passwords/keys (unchanged).
