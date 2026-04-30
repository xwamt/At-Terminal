# AT Terminal Agent Context, SFTP Tools, And MCP Config Design

## Goal

Expand AT Terminal's agent-facing surface now that the Copilot language model tools and local MCP bridge path are proven to work.

The next version should let VS Code agents and MCP-capable IDEs understand the current SSH context, inspect and edit remote files through SFTP, and install MCP configuration with less manual setup.

## Scope

This design covers four batches in priority order:

1. Dual package variants: `AT Terminal` base and `AT Terminal MCP`.
2. Read-only terminal context tools.
3. SFTP read/write tools without destructive file management.
4. MCP configuration installation command, with optional first-run prompt later.

The feature must expose equivalent capabilities through both integration paths:

- GitHub Copilot Chat uses `contributes.languageModelTools` and `vscode.lm.registerTool`.
- Continue, Cursor, Kiro, and similar IDEs use the local MCP stdio server, which calls the localhost bridge inside the AT Terminal extension host.

The MCP sidecar must not read VS Code storage, AT Terminal config, or secrets directly. It should continue to call the localhost bridge so all credential access, SFTP sessions, host-key behavior, and confirmation UI remain inside the extension host.

The base package must not expose agent tools, start the MCP bridge, include the MCP stdio server entrypoint, or include MCP-specific dependencies in its VSIX. Users who only want SSH terminal and SFTP UI should install the base package.

## Confirmed Product Decisions

- Terminal context tools are read-only for the first batch.
- AT Terminal should ship as two VSIX variants from one source tree:
  - `AT Terminal`: base SSH terminal and SFTP UI only.
  - `AT Terminal MCP`: base functionality plus Copilot tools, local MCP bridge, MCP stdio server, and MCP config installer.
- "Current tab" context should not collapse into one ambiguous value. Tools should return both `focusedTerminal` and `defaultConnectedTerminal`.
- SFTP first batch is read/write but excludes dangerous operations.
- SFTP write operations require confirmation the first time each server is written to during the current extension host session.
- MCP config automation starts as an explicit command. A first-run prompt can be added later.

## Architecture

Keep a single capability implementation in the extension host and expose it through two adapters in the MCP variant:

- **Core services:** terminal context registry, SFTP manager/session, write authorization, and MCP config installer.
- **Language model tool adapter:** converts VS Code language model tool input/output into core service calls.
- **Bridge adapter:** exposes the same core calls over localhost HTTP for the MCP stdio server.
- **MCP stdio adapter:** registers MCP tools and forwards tool calls to `BridgeClient`.

This avoids splitting behavior between Copilot and MCP clients. Tool names, input schemas, errors, and response shapes should stay aligned across both adapters.

### Package Variant Architecture

Use one source tree and two package/build variants:

- `package.base.json`
  - display name: `AT Terminal`
  - no `contributes.languageModelTools`
  - no `onLanguageModelTool:*` activation events
  - no `sshManager.installMcpConfig` command
  - no MCP stdio server entrypoint in the VSIX
- `package.mcp.json`
  - display name: `AT Terminal MCP`
  - includes all Copilot language model tools
  - includes `sshManager.installMcpConfig`
  - includes `dist/mcp-server.js`
  - includes dependencies required by the MCP stdio server

Build and package through variant scripts rather than maintaining two source trees. The extension runtime should have a build-time flag such as `MCP_ENABLED` so the base bundle does not register language model tools or start the localhost MCP bridge. The MCP bundle sets the flag true and builds `dist/mcp-server.js`.

Packaging should stage each variant into an isolated temporary directory before running `vsce package`. This prevents the base VSIX from accidentally including MCP-only build outputs or dependencies.

## Terminal Context Tools

### Tool: `get_terminal_context`

Purpose: Let an agent see SSH terminal state before deciding which server to use.

Response should include:

- `focusedTerminal`: the AT Terminal panel currently focused in the editor, if known.
- `defaultConnectedTerminal`: the connected terminal that tools will use when `serverId` or `terminalId` is omitted or set to `active`.
- `connectedTerminals`: all known connected terminal contexts.
- `knownTerminals`: known terminal contexts, including disconnected contexts that are still relevant.

Each terminal summary should include:

- `terminalId`
- `serverId`
- `label`
- `host`
- `port`
- `username`
- `connected`
- `focused`
- `default`

The tool must not return passwords, private key paths, private key contents, or secret identifiers.

### Focus Semantics

`focusedTerminal` means the AT Terminal webview panel that VS Code most recently reported as active. It can be undefined if focus is outside AT Terminal.

`defaultConnectedTerminal` means the connected terminal that command and SFTP tools use by default. It should prefer the focused connected terminal, then fall back to the most recently connected terminal. This matches the recent fix for `serverId: "active"`.

## SFTP Tools

### First-Batch Tools

Expose these tools through both Copilot and MCP:

- `sftp_list_directory`
- `sftp_stat_path`
- `sftp_read_file`
- `sftp_write_file`
- `sftp_create_file`
- `sftp_create_directory`

No first-batch tool should delete, rename, move, upload arbitrary local files, or download to arbitrary local paths.

### Target Selection

Every SFTP tool should accept optional target selectors:

- `terminalId`
- `serverId`

Resolution order:

1. If `terminalId` is provided, use that connected terminal.
2. Else if `serverId` is provided, use a connected terminal for that server if one exists.
3. Else use `defaultConnectedTerminal`.

If no matching connected terminal exists, return a clear error that tells the user to connect an AT Terminal session first.

### Path Inputs

Paths are remote POSIX paths. Tools should accept absolute paths and relative paths. Relative paths resolve from the SFTP manager's current root for the selected terminal when available; otherwise from the remote login directory after `realpath('.')`.

Write and create tools should reject empty paths and paths that normalize to the remote root.

### Read Limits

`sftp_read_file` should be bounded:

- default max bytes: 64 KiB
- hard max bytes: 256 KiB
- response includes `truncated: boolean`

The tool should return text content as UTF-8. Binary-looking files should return a clear error or a metadata-only response rather than dumping binary bytes into chat.

### Write Semantics

`sftp_write_file` writes UTF-8 text content to a remote file. It may overwrite an existing file only when the tool input explicitly allows overwrite.

Suggested input:

- `path`
- `content`
- `overwrite?: boolean`
- `terminalId?: string`
- `serverId?: string`

If `overwrite` is false or omitted and the remote path exists, return an error.

`sftp_create_file` creates an empty file or a file with provided text content, but fails if the path already exists.

`sftp_create_directory` creates one directory path. Recursive directory creation can be a later enhancement unless existing SFTP APIs make it trivial and safe.

## SFTP Write Authorization

Read-only SFTP tools do not require confirmation.

Write tools require a VS Code confirmation prompt the first time a server is written to during the current extension host session. After approval, subsequent write operations for the same `serverId` do not prompt again until reload/restart.

Confirmation prompt should include:

- server label and host
- operation name
- remote path
- whether the operation may overwrite an existing file

Authorization is in-memory only. It is not persisted to disk or VS Code global state.

## MCP Configuration Installation

### Command: `AT Terminal: Install MCP Config`

Add an explicit command that helps users configure local MCP clients.

First version should support Continue config writing because the target shape is known from the current docs:

```yaml
name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - <installed-extension-path>/dist/mcp-server.js
```

The command should:

1. Resolve the installed extension path.
2. Verify `dist/mcp-server.js` exists.
3. Detect or ask for the target MCP client.
4. For Continue, create or update the workspace MCP config.
5. Show a summary of the file path changed and the command configured.

Cursor and Kiro should be handled conservatively in the first version:

- detect likely config paths where possible;
- show copyable config or ask the user to select the config file;
- avoid silent writes when the path or schema is uncertain.

### Optional Later Prompt

A later version may show a first-run prompt after activation:

> AT Terminal can install MCP configuration for compatible IDEs. Install now?

That prompt is out of first implementation scope unless the explicit command proves reliable.

## Error Handling

Errors should be short, actionable, and consistent across Copilot and MCP:

- No extension bridge: ask the user to open/reload VS Code with AT Terminal enabled.
- No connected terminal: ask the user to connect an AT Terminal SSH session.
- Unknown `terminalId` or `serverId`: say which identifier was not found.
- SFTP unavailable: include the server label and the underlying error message.
- Write not authorized: say the user cancelled the write confirmation.
- File exists: ask the agent/user to pass `overwrite: true` for `sftp_write_file` or choose a new path.
- Large/binary file: ask for a smaller range or a text file.

Bridge HTTP errors should continue to return JSON `{ "error": string }`.

## Testing Strategy

Add focused tests around core behavior rather than only adapter wiring:

- Base package VSIX metadata excludes `languageModelTools`, `onLanguageModelTool:*`, `dist/mcp-server.js`, and MCP config command.
- MCP package VSIX metadata includes agent tools, MCP bridge/server packaging, and MCP config command.
- Terminal context registry returns both focused and default connected terminals.
- Agent and MCP bridge adapters expose `get_terminal_context`.
- SFTP read tools call `SftpManager`/session without requiring confirmation.
- SFTP write tools ask for confirmation once per server per extension host session.
- Write authorization is not persisted.
- `sftp_read_file` enforces size and binary safeguards.
- `sftp_write_file` rejects overwrite unless explicitly allowed.
- MCP stdio manifest includes new tool registrations.
- MCP config installer writes Continue config only after explicit command invocation.

Manual tests should cover:

- Copilot Chat can call context and SFTP tools.
- Continue can call the same tools through MCP.
- Writing a file prompts once per server, then proceeds without repeated prompts.
- Reloading the window clears write authorization.
- Install MCP Config creates a usable Continue config.
- Base VSIX installs without exposing Copilot or MCP tools.
- MCP VSIX installs with Copilot tools and local MCP config support.

## Out Of Scope For This Batch

- SFTP delete, rename, move, upload local files, download to arbitrary local paths.
- Changing the active terminal or selected server from an agent tool.
- Persisted write authorization.
- Remote shell working-directory tracking from terminal output.
- Multi-file patch application.
- Streaming very large remote files through MCP.
- Silent automatic MCP config writes on install.
- Publishing two Marketplace listings.
- Maintaining duplicated source trees for base and MCP variants.

## Open Implementation Notes

- Existing `SftpManager` currently tracks one terminal context for the side panel. Agent SFTP tools may need a separate session registry keyed by `terminalId` to avoid stealing the sidebar's session.
- If a separate SFTP session registry is added, it should still reuse `SftpSession` and existing config/secret access.
- The terminal context registry needs enough metadata to distinguish focused terminal from default connected terminal.
- Tool schemas should be generated or centralized where practical so Copilot and MCP do not drift.
- Package variant generation should be deterministic and testable; avoid manually editing `package.json` before each package command.
