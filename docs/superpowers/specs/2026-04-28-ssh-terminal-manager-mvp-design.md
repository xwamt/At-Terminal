# SSH Terminal Manager MVP Design

Date: 2026-04-28
Source document: `SSH_Terminal_Manager_Design.docx`
Status: Draft for user review

## 1. Goal

Build a lightweight VS Code extension for managing SSH terminal sessions from the VS Code sidebar. The extension lets users manually maintain a grouped server list, connect to servers, and open independent xterm.js terminal tabs inside the workbench.

The MVP favors a stable, publishable first version over broad SSH feature coverage. It is a pure client-side terminal manager and does not require VS Code Server or any agent installed on the remote host.

## 2. MVP Scope

Included in the first version:

- Manual server add, edit, delete, and copy host actions.
- Webview form for adding and editing server configurations.
- Lightweight server grouping with an optional `group` field.
- TreeView grouped by server group, with ungrouped servers shown in a default group.
- Direct SSH connections only.
- Password and private key authentication only.
- One new terminal tab per connect action.
- Multiple terminal tabs for the same server.
- One independent SSH client per terminal tab.
- xterm.js terminal Webview with input, output, resize, basic theme, font, and scrollback support.
- Disconnect and manual reconnect for the current terminal tab.
- Basic known_hosts-style host fingerprint trust flow.

Explicitly deferred:

- SSH config import.
- SSH agent authentication.
- Jump hosts.
- Automatic reconnect.
- Quick commands.
- SFTP browser.
- Port forwarding UI.
- Shared SSH connection pool.
- Multi-level group management or drag-and-drop group editing.

## 3. Architecture

The extension keeps the original three-layer structure from the design document, but simplifies connection management so each terminal tab owns its own SSH client and shell channel.

```text
VS Code UI
- Activity Bar / TreeView: server list, groups, context menus
- Webview form: add and edit servers
- Webview terminal: xterm.js terminal panel

Extension Host
- command registration
- config storage
- SecretStorage credential management
- host fingerprint storage and validation
- SSH session lifecycle
- Webview message routing

Remote Host
- ssh2 Client
- shell channel
- remote PTY
```

The key architecture decision is to avoid a global connection pool in the MVP. Each terminal tab gets a dedicated `SshSession`. Closing a tab releases that tab's SSH client and channel. Reconnecting affects only the current tab. This keeps lifecycle behavior clear and reduces cross-tab failure coupling.

## 4. Modules

### `src/extension.ts`

Registers commands, TreeView, form panels, terminal panels, and extension lifecycle hooks. It wires together the config, tree, Webview, and SSH modules.

### `src/config/ConfigManager.ts`

Manages server configuration CRUD. Non-sensitive fields are stored in VS Code `globalState`. Passwords are stored separately in `vscode.SecretStorage`. Private key contents are never copied or persisted by the extension; only the local path is stored.

### `src/config/schema.ts`

Defines runtime validation for server configs. MVP validation only permits `authType: 'password' | 'privateKey'`.

### `src/tree/ServerTreeProvider.ts`

Displays servers grouped by `group`. Server nodes expose context menu actions for connect, edit, delete, and copy host.

### `src/webview/ServerFormPanel.ts`

Creates the Webview form for adding and editing servers. It owns form HTML, client-side field validation, submit messages, and error presentation.

### `src/webview/TerminalPanel.ts`

Creates terminal WebviewPanels, injects CSP and nonce-protected scripts, loads the xterm bundle, and bridges terminal input, output, resize, disconnect, and reconnect messages.

### `src/ssh/SshSession.ts`

Represents one terminal tab's SSH client and shell channel. It exposes connect, disconnect, reconnect, write, resize, and dispose operations, and emits state and output events back to the terminal panel.

### `src/ssh/HostKeyStore.ts`

Stores trusted host fingerprints and validates them during connection. Unknown hosts require user confirmation. Fingerprint changes block the connection.

### `webview/terminal/index.ts`

Initializes xterm.js, fit addon, web links addon, resize observer, and postMessage communication with the extension host.

### `webview/server-form/index.ts`

Implements the add/edit form UI and client-side validation.

### `src/utils/`

Contains small shared helpers for logging, nonce generation, path checks, error formatting, and sensitive-value redaction.

## 5. Data Model

```ts
interface ServerConfig {
  id: string;
  label: string;
  group?: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
  privateKeyPath?: string;
  keepAliveInterval: number;
  encoding: 'utf-8';
  createdAt: number;
  updatedAt: number;
}
```

Passwords are not stored in `ServerConfig`. They are stored in `SecretStorage` using a key derived from `serverId`.

Deferred fields such as `jumpHost`, `tags`, `agent`, quick commands, and auto-reconnect settings are not part of the MVP model.

Host fingerprint trust records:

```ts
interface TrustedHostKey {
  host: string;
  port: number;
  fingerprint: string;
  algorithm?: string;
  trustedAt: number;
}
```

The storage key is `${host}:${port}`, so the same host on different ports is trusted independently.

## 6. Commands

MVP command list:

- `sshManager.addServer`: open the add server Webview form.
- `sshManager.editServer`: open the edit server Webview form.
- `sshManager.deleteServer`: delete the selected server after confirmation and remove its password.
- `sshManager.connect`: open a new terminal tab and start an SSH session.
- `sshManager.disconnect`: disconnect the current terminal tab's SSH session.
- `sshManager.reconnect`: manually reconnect the current terminal tab.
- `sshManager.copyHost`: copy `username@host:port` for the selected server.
- `sshManager.refresh`: refresh the server TreeView.

Deferred commands:

- `sshManager.sendCommand`
- `sshManager.importFromSSHConfig`

## 7. User Flows

### Add Server

1. User runs Add Server.
2. Extension opens the server form Webview.
3. User enters label, optional group, host, port, username, and authentication type.
4. For password auth, the submitted password is written to `SecretStorage`.
5. For private key auth, the private key path is saved in the server config.
6. Non-sensitive config is persisted to `globalState`.
7. TreeView refreshes and displays the server under its group.

### Connect Server

1. User selects Connect from a server node.
2. Extension creates a new terminal WebviewPanel.
3. Extension creates a new `SshSession` for that panel.
4. `SshSession` starts an SSH connection.
5. If the host fingerprint is unknown, the extension shows host, port, and fingerprint and asks the user to trust or cancel.
6. If the host fingerprint changed from the trusted value, the extension blocks the connection and shows an error.
7. On successful SSH connection, `SshSession` opens a shell channel.
8. xterm input is sent to the extension host through postMessage and written to the shell.
9. Shell output is posted back to the Webview and rendered by xterm.js.

### Disconnect, Reconnect, and Close

- Disconnect closes the shell channel and SSH client for the current tab and leaves the terminal panel open with a disconnected state.
- Manual reconnect disposes the previous session for the tab and creates a new SSH client and shell channel from the same server config. The Webview and local scrollback remain.
- Closing the terminal tab disposes the corresponding `SshSession`.

## 8. Error Handling

- Form validation errors are shown inside the server form Webview.
- Missing credentials prompt the user to edit the server configuration.
- Private key path errors block connection and show a readable error.
- SSH connection errors are shown in the terminal panel status area or terminal output.
- Fingerprint mismatches block connection and explain the risk.
- Message payload validation failures are rejected and logged without executing actions.

## 9. Security

- Passwords are stored only in `vscode.SecretStorage`.
- Passwords must not be stored in `globalState`, Webview HTML, logs, or serialized errors.
- Private key contents are read only during connection and are not copied or cached long-term.
- Private key path existence is checked before connection. Unix/macOS may warn on overly broad file permissions; Windows does not enforce this in MVP.
- Unknown host fingerprints require explicit user trust.
- Changed host fingerprints block the connection.
- Webviews use strict CSP: no remote resources, nonce-protected scripts, and local resources restricted to the extension URI.
- postMessage handlers validate message `type` and payload shape before acting.
- Delete server also deletes that server's stored password.

## 10. Testing Strategy

### Unit Tests

- `ConfigManager` CRUD.
- Server schema validation.
- SecretStorage key generation.
- Host fingerprint matching and mismatch behavior.
- Error formatting and redaction helpers.

### Integration Tests

- VS Code command registration.
- TreeView group rendering.
- Server form submit flow.
- TerminalPanel lifecycle.
- Tab dispose releases its session.

### End-to-End Tests

Use a Docker SSH container to verify:

- Password login.
- Private key login.
- Terminal input and output.
- Terminal resize.
- Disconnect.
- Manual reconnect.
- Unknown fingerprint confirmation.
- Fingerprint mismatch blocking.

High-risk cases that must be covered before release:

- Passwords are never written into server config.
- Deleting a server removes the stored password.
- Two tabs for the same server do not affect each other.
- Closing one tab does not affect another tab.
- Manual reconnect affects only the current tab.
- Host fingerprint mismatch cannot continue silently.

## 11. Milestones

### M1: Project Scaffold and Extension Shell

- `package.json`, TypeScript, esbuild, and extension entry.
- Command registration.
- Activity Bar and TreeView placeholder.
- Basic logging and utility setup.

### M2: Server Config and Webview Form

- `ConfigManager`.
- Runtime schema.
- SecretStorage integration.
- Add, edit, delete, copy host.
- Lightweight grouping in TreeView.

### M3: SSH Terminal Core

- `SshSession`.
- Password and private key direct SSH.
- TerminalPanel.
- xterm.js input and output bridge.
- Resize bridge.
- Tab close cleanup.

### M4: Security and Session Polish

- Host fingerprint trust flow.
- Disconnect.
- Manual reconnect.
- Error presentation.
- Log redaction.
- CSP hardening.

### M5: Tests and Release Preparation

- Unit tests.
- VS Code integration tests.
- Docker SSH end-to-end tests.
- README.
- Marketplace metadata.
- Package v0.1.0.

## 12. Open Decisions

No open product decisions remain for the MVP. Implementation details may be refined during planning, but the feature scope is fixed for the first version.

