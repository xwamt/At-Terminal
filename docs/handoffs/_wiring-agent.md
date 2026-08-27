# Wiring — slice D (agent-mcp)

Snippets the integrator must apply to files this slice does not own (`src/extension.ts`,
`l10n/**`). Everything below compiles against the slice-D versions of `src/agent/**` and
`src/mcp/**`.

## 1. `extension.ts`: dispose agent SFTP sessions when a terminal closes (leak fix)

In the existing `onDidRemoveContext` handler, also drop the pooled agent SFTP session:

```ts
terminalContext.onDidRemoveContext((terminalId) => {
  sftpManager.removeTerminalContext(terminalId);
  sftpAgentService?.disposeTerminal(terminalId);
});
```

Note: `sftpAgentService` is declared after this handler today (`let sftpAgentService: SftpAgentService | undefined;` currently sits below the `onDidRemoveContext` registration). Either move the `let` declaration above the handler or move the handler registration below the MCP block — the closure only reads it at event time, so both work; hoisting the `let` is the smaller diff.

## 2. `extension.ts`: server deletion / edits

Where a server is deleted (the `sshManager.deleteServer` flow), also drop pooled agent
connections for it:

```ts
sftpAgentService?.disposeServer(server.id);
```

(Optional but recommended for edited servers too, so a changed host/credential does not
keep serving through a stale pooled session.)

## 3. `extension.ts`: background SFTP + audit wiring

`SftpAgentService`'s `createSession` now receives `{ server: ServerConfig }` instead of a
full `TerminalContext` (the existing inline lambda `(terminal) => new SftpSession(terminal.server, …)`
still compiles unchanged). Add `resolveBackgroundServer` and `audit`:

```ts
import { createAgentAuditLog } from './agent/AgentAuditLog';

const agentAuditLog = createAgentAuditLog(context.globalStorageUri);

sftpAgentService = new SftpAgentService({
  terminalContext,
  // Agent writes never escalate: a denied write stays denied instead of silently
  // becoming a root write through the sudo fallback.
  createSession: (target) =>
    new SftpSession(target.server, configManager, hostKeyVerifier, { allowSudoFallback: false }),
  authorizer: sftpWriteAuthorizer,
  // Background SFTP: only servers with backgroundConnectionAllowed === true are accepted;
  // SftpAgentService enforces the flag itself after resolution.
  resolveBackgroundServer: (serverId) => configManager.getServer(serverId),
  audit: agentAuditLog
});

const agentToolService = new AgentToolService({
  configManager,
  terminalContext,
  executor: remoteCommandExecutor,
  sftp: sftpAgentService,
  audit: agentAuditLog
});

context.subscriptions.push(agentAuditLog);
```

`createAgentAuditLog` creates the `AT Terminal Agent Audit` OutputChannel and writes
JSONL to `<globalStorageUri>/agent-audit.jsonl`. Its `dispose()` disposes the channel.

## 4. `extension.ts`: hub sync Repair fast-path bypass

`syncPackagedHub(context)` now persists a fast-path state file under
`context.globalStorageUri` and skips the full sha256 read when version + size/mtime
still match. The Repair action (UX slice's Repair button / `sshManager.installMcpConfig`)
must force the full hash-based election:

```ts
await syncPackagedHub(context, { force: true });
```

Plain activation keeps calling `syncPackagedHub(context)` unchanged.

## 5. New `t()` strings (UX slice: add matching keys to `l10n/bundle.l10n.zh-cn.json`)

From `src/agent/AgentToolService.ts`:

- `Run Command`

From `src/agent/SftpWriteAuthorizer.ts` (delete confirmation):

- `Delete Once`
- `Delete It Anyway, Once`
- `Allow AT Terminal agent to delete a remote file on {label} ({host})?`
- `Path: {path}`
- `Folder: {folder}`
- `WARNING: outside the working directory {root} that this session was opened in.`
- `WARNING: sensitive system path (SSH keys, service units, cron, or system configuration).`
- `Deleting always asks, even on fully trusted servers, and this answer is never remembered.`
- `{path} is a sensitive system path on {host}.`
- `Deleting here can break logins, services, or scheduled jobs on the server.`
- `Confirm once more to allow this single delete. This answer is never remembered.`

## 6. Behavior notes for the integrator

- `sftp_rename` / `sftp_delete` are registered in the tool catalog, bridge schemas, and
  `BridgeServer` routes; no extension.ts change needed for them.
- `sftp_delete` never joins a directory/session grant and is **not** skipped by full
  trust; `SftpWriteAuthorizer.requireDelete` enforces this, do not route deletes through
  `requireWrite`.
- Background-denied errors (both command and SFTP paths) tell the agent to have the user
  enable "Allow background connections" on the AT Terminal server edit form.
- `run_remote_command` confirmation now times out after 120 s with an actionable error
  instead of parking the agent forever; command timeouts keep captured stderr and append
  the timeout notice.
