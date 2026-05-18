# Jump Host Support Design

Date: 2026-05-18
Status: Approved for implementation planning

## Goal

Add first-class jump host support to SSH assets. Users can configure an asset to connect through another saved asset, then use that route consistently for terminal sessions, connection tests, SFTP, and MCP-backed remote commands.

The selected product direction is a conservative one-level jump host model. It adds a `Jump Host` selector to the existing asset add/edit form and keeps direct connections as the default behavior.

## Scope

Included:

- Add an optional `jumpHostId` field to saved server assets.
- Let users choose an existing saved asset as the jump host from the add/edit asset form.
- Exclude the asset currently being edited from its own jump host options.
- Support only one effective jump host hop for a target asset.
- Route terminal SSH sessions through the selected jump host.
- Route form connection tests through the selected jump host.
- Route SFTP sessions through the selected jump host.
- Route remote command and MCP tool SSH connections through the selected jump host.
- Block deletion of an asset that is referenced as another asset's jump host.
- Preserve direct SSH behavior for assets without a jump host.

Deferred:

- Multi-hop jump host chains.
- SSH config import or `ProxyJump` parsing.
- Jump host-specific credentials copied into target assets.
- Port forwarding UI.
- Jump host health indicators in the asset tree.
- Bulk reassignment when deleting a jump host asset.

## Data Model

`ServerConfig` gains an optional `jumpHostId?: string` field. The value stores only the ID of another saved asset. It does not copy label, host, username, port, authentication type, or private key information from the jump host asset.

This keeps the source of truth in one place. If a jump host asset changes host, username, port, or credentials, every target asset that references it uses the updated jump host configuration on the next connection.

Existing saved assets without `jumpHostId` remain valid and continue to connect directly.

## Configuration Rules

The add/edit form's `Jump Host` selector only lists assets that already exist in configuration storage. New unsaved form values cannot be used as a jump host.

When editing an existing asset, the selector excludes that same asset to prevent direct self-reference. The implementation supports one effective hop: when an asset is used as a jump host, its own `jumpHostId` is ignored for that intermediate connection.

If a target asset references a missing jump host ID, connection attempts fail with a clear error such as `Jump host "<id>" was not found.` The UI should surface that error in the same place as other connection failures.

## Deletion Rule

Deleting a saved asset is blocked if any other saved asset references it as `jumpHostId`.

The delete command should report which assets are using the selected asset as a jump host so the user can update those assets first. This avoids silently leaving invalid references or clearing route configuration behind the user's back.

## User Experience

The asset add/edit form uses the selected UI approach: add `Jump Host` inside the existing `Connection` panel.

The selector has a default direct option, for example `Direct connection`. Saved jump host options show enough information to distinguish assets, such as:

```text
Bastion CN - ops@bastion.example.com:22
```

The summary panel adds a route line:

- `Route: Direct connection` when no jump host is selected.
- `Route: via <jump host label>` when a jump host is selected.

The `Test Connection` button stays in the current footer. When a jump host is selected, the testing status can be more specific, for example `Testing connection via Bastion CN...`. Success can remain `Connection test succeeded.` Failures show the underlying formatted error.

## Connection Flow

All asset-based SSH connections use one shared connection configuration path instead of each caller implementing jump host logic separately. This keeps terminal, test connection, SFTP, remote command, and MCP behavior consistent.

For an asset without `jumpHostId`, the flow remains the existing direct SSH connection.

For an asset with `jumpHostId`:

1. Resolve the jump host asset from `ConfigManager`.
2. Build a direct SSH connection to the jump host asset using the jump host's own host, port, username, authentication, keepalive, and host key verification.
3. After the jump host client is ready, call `forwardOut` on the jump host client to create a TCP channel from the jump host to the target asset's `host:port`.
4. Build the target asset's SSH connect config using its own username, authentication, keepalive, and host key verification.
5. Pass the forwarded channel as the target SSH connection's `sock`.

The target asset still owns its authentication and host key validation. The jump host only supplies the network path to reach the target host and port.

## Lifecycle

Connections that use a jump host own two SSH clients: the jump host client and the target client. The lifecycle must close both.

Connection tests close both clients on success, failure, and timeout. Terminal, SFTP, and remote command flows release the jump host client when the target connection is disposed or closed. This prevents background jump host sessions from leaking after the user closes the target session.

## Module Impact

Expected implementation touch points:

- `src/config/schema.ts`: add and validate optional `jumpHostId`.
- `src/config/ConfigManager.ts`: add helper behavior for reference checks if useful.
- `src/webview/ServerFormPanel.ts`: pass saved server options into the form, parse `jumpHostId`, render selector options, and handle test connection resolution.
- `webview/server-form/index.ts`: include `jumpHostId` in form payload and live summary.
- `webview/server-form/index.css`: style the selector within the current connection panel.
- `src/ssh/SshConnectionConfig.ts`: centralize jump host-aware connection config creation.
- `src/ssh/SshConnectionTester.ts`: ensure tests close jump host and target clients.
- `src/ssh/SshSession.ts`: retain and dispose the jump host connection when opening terminals.
- `src/sftp/SftpSession.ts`: reuse the same route-aware SSH config or equivalent shared helper.
- `src/agent/RemoteCommandExecutor.ts`: use the route-aware connection path.
- `src/extension.ts`: pass server lists into add/edit forms and enforce deletion blocking.

The exact helper boundaries can be refined during implementation planning, but jump host behavior should remain centralized enough that callers do not duplicate routing logic.

## Testing Strategy

Schema and configuration tests:

- Accept configs with no `jumpHostId`.
- Accept configs with a non-empty `jumpHostId`.
- Preserve compatibility for existing stored assets.
- Verify deletion is blocked when another asset references the selected asset as a jump host.

Form rendering and message tests:

- Render the `Jump Host` selector in the `Connection` panel.
- Show the direct connection option by default.
- Render saved assets as jump host options.
- Exclude the currently edited asset from its own selector options.
- Submit `jumpHostId` when selected and omit it when direct.
- Display the route summary for direct and jump host paths.

Connection tests:

- Direct assets keep the current connection behavior.
- Assets with `jumpHostId` connect to the jump host first.
- Target connections receive a forwarded `sock`.
- A missing jump host ID returns a clear error.
- A jump host asset's own `jumpHostId` is ignored when it is used as the intermediate host.
- Connection test cleanup closes both the target client and jump host client on success, failure, and timeout.

Regression tests:

- Terminal sessions, SFTP sessions, and remote command execution use the same route-aware behavior.
- Existing password and private key behavior remains unchanged for direct connections.
- Host key verification still runs against the effective host and port for each SSH client.

## Open Decisions

None. The selected behavior is:

- UI placement: `Jump Host` selector in the existing `Connection` panel.
- Scope: terminal, test connection, SFTP, remote commands, and MCP.
- Chain behavior: one effective hop; ignore the jump host asset's own `jumpHostId`.
- Deletion behavior: block deleting assets that are referenced as jump hosts.
