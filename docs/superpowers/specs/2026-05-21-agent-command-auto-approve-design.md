# Agent Command Auto Approve Design

Date: 2026-05-21
Status: Approved for implementation planning

## Goal

Add a per-server trust switch for AT Terminal MCP remote command execution.

When enabled for a saved SSH server, non-destructive `run_remote_command` calls from an agent may execute without the current per-command VS Code confirmation dialog. Destructive-looking commands still require confirmation.

## Scope

Included:

- Add a per-server boolean setting for agent remote command auto approval.
- Default the setting to off for new and existing servers.
- Add the setting to the server add/edit form.
- Show the setting in the form summary before save.
- Skip the `run_remote_command` confirmation only when the target server has the setting enabled and the command is not obviously destructive.
- Keep the existing confirmation dialog for dangerous commands.

Excluded:

- No change to SFTP write authorization.
- No change to SSH host key fingerprint trust.
- No global default or bulk trust setting.
- No trusted path, trusted command allowlist, or command pattern management.
- No change to MCP client-side `autoApprove` config generation.

## Data Model

`ServerConfig` gains an optional boolean field:

```ts
agentCommandAutoApprove?: boolean;
```

The field is optional for backward compatibility. Missing values behave the same as `false`.

The setting's meaning is deliberately narrow: it only controls whether ordinary agent-triggered remote commands may bypass the AT Terminal confirmation prompt. It does not imply broader trust for file writes, host identity checks, credentials, jump hosts, or other MCP tools.

## User Experience

The server add/edit form adds a switch in the existing connection-oriented area. The label should be:

```text
Trust agent remote commands
```

Supporting text should make the limit clear:

```text
Run non-destructive MCP remote commands without asking each time.
```

New servers default to the switch off. Editing an existing server reflects the saved value.

The summary panel should include a concise status line so the user can review the security-sensitive setting before saving:

- `Agent commands: manual approval`
- `Agent commands: trusted for non-destructive commands`

## Execution Flow

`AgentToolService.runRemoteCommand` keeps the current command validation and server resolution flow.

After resolving the server and detecting whether the command is obviously destructive:

1. If `server.agentCommandAutoApprove === true` and the command is not destructive, execute the command without calling `vscode.window.showWarningMessage`.
2. If the setting is off, keep the current confirmation dialog.
3. If the command is destructive, keep the current confirmation dialog even when the setting is on.

The destructive command warning text stays in the confirmation message:

```text
Warning: this command appears destructive.
```

The existing destructive-command heuristic is sufficient for this feature. This design does not attempt to make destructive command detection complete or policy-grade.

## Safety Properties

SFTP write operations continue to use `SftpWriteAuthorizer` and keep their current first-write authorization behavior.

SSH host key trust remains independent. Unknown or changed host fingerprints still require the existing host key flow. The agent trust switch must not bypass host identity checks.

The setting is per server, so trusting one server does not affect any other saved server.

Dangerous commands remain interactive because the risk is tied to command content, not only the selected server.

## Testing Strategy

Schema and config tests:

- Accept existing server configs without `agentCommandAutoApprove`.
- Accept `agentCommandAutoApprove: true`.
- Accept `agentCommandAutoApprove: false`.
- Preserve strict validation for unrelated unknown fields.

Form tests:

- Render the trust switch in the server form.
- Default the switch to off for new servers.
- Check the switch when editing a trusted server.
- Submit `agentCommandAutoApprove: true` when enabled.
- Submit or normalize `false` when disabled.
- Render summary text for both trusted and manual states.

Agent command tests:

- Untrusted server plus ordinary command still shows confirmation.
- Trusted server plus ordinary command skips confirmation and calls the executor.
- Trusted server plus destructive command still shows confirmation.
- Trusted server plus destructive command still cancels when the user declines.
- Empty commands still fail before any confirmation or execution.

Regression tests:

- SFTP write authorization behavior is unchanged.
- Host key verification behavior is unchanged through the existing SSH connection path.
- `list_ssh_servers` continues to omit credentials and includes `agentCommandAutoApprove` so agents can report whether a server uses manual or trusted command approval.

## Open Decisions

None. The selected behavior is:

- One boolean field per server.
- Only `run_remote_command` is affected.
- Only non-destructive commands skip confirmation.
- SFTP writes and host key trust stay unchanged.
