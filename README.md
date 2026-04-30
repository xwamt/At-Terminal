# AT Terminal MCP

AT Terminal MCP is the MCP-enabled build of AT Terminal, an agentless SSH terminal and SFTP workspace extension for VS Code-compatible IDEs.

It keeps the original AT Terminal SSH/SFTP experience and adds two agent integration paths:

- VS Code language model tools for GitHub Copilot Chat and other VS Code agents.
- A local MCP stdio server for MCP-capable IDEs such as Kiro, Cursor, Continue, and compatible VS Code forks.

The non-MCP build is packaged separately as `AT Terminal` and uses `README-base.md`. This README is for the MCP build, packaged as `AT Terminal MCP`.

![AT Terminal icon](media/at-terminal-icon.png)

## What It Does

AT Terminal connects directly to SSH servers without installing VS Code Server, a remote daemon, or any server-side agent. It provides:

- SSH terminal tabs inside the IDE.
- SFTP browsing, upload, download, rename, delete, preview, and local edit workflows.
- Host key verification and changed-host-key blocking.
- Password and private-key authentication through the existing AT Terminal configuration.
- Local editor sessions for remote files, so AI agents can inspect and edit remote scripts as normal local documents.
- Optional MCP tools that let an agent list configured servers, inspect connected terminal context, run confirmed remote commands, and perform bounded SFTP reads/writes.

## MCP Architecture

The MCP server shipped by this extension does not read AT Terminal credentials directly.

The flow is:

1. The AT Terminal MCP extension starts inside the VS Code-compatible IDE.
2. The extension starts a localhost bridge and writes a discovery file under the user's home directory.
3. The MCP stdio server is launched by Kiro, Cursor, Continue, or another MCP client.
4. The MCP server connects back to the localhost bridge.
5. Tool calls are handled by the extension, using the same AT Terminal server config, SecretStorage credentials, host key verification, and confirmation prompts.

This means the IDE extension must be running before MCP tools can work. If the MCP client reports that it cannot connect to AT Terminal, open the IDE where AT Terminal MCP is installed and activate the extension by opening the AT Terminal view or running an AT Terminal command.

## Agent Tools

The MCP build exposes the following tools.

| Tool | Type | Description |
| --- | --- | --- |
| `list_ssh_servers` | read-only | Lists configured SSH server ids and metadata without exposing passwords or private keys. |
| `get_terminal_context` | read-only | Shows focused, default connected, connected, and known AT Terminal SSH terminal context. |
| `run_remote_command` | command | Runs a confirmed non-interactive SSH command and returns stdout, stderr, exit code, timeout, duration, and truncation metadata. |
| `sftp_list_directory` | read-only | Lists a remote directory through a connected AT Terminal SFTP session. |
| `sftp_stat_path` | read-only | Returns metadata for a remote file or directory. |
| `sftp_read_file` | read-only | Reads bounded UTF-8 text from a remote file. Binary-looking content is rejected. |
| `sftp_write_file` | write | Writes UTF-8 text to a remote file. Existing files require `overwrite: true`. |
| `sftp_create_file` | write | Creates a new remote file, optionally with UTF-8 content. |
| `sftp_create_directory` | write | Creates a new remote directory. |

Safety behavior:

- `run_remote_command` asks for confirmation before every command.
- SFTP write tools ask for first-write authorization per server during the current extension host session.
- Read tools do not expose stored passwords, private keys, or secret values.
- SFTP reads are bounded to avoid dumping large files into chat.
- Write tools resolve remote paths through the connected SFTP session and do not allow modifying the remote root path.

Targeting behavior:

- Pass `terminalId` to target a specific connected AT Terminal tab.
- Pass `serverId` to target a connected terminal for that server.
- Omit both to use `defaultConnectedTerminal`.
- Use `get_terminal_context` first when you are not sure which terminal is active.

## Install From VSIX

Build and package both variants:

```powershell
npm install
npm run package:base
npm run package:mcp
```

Generated files:

- `at-terminal-0.2.9.vsix`: base extension without MCP tools.
- `at-terminal-mcp-0.2.9.vsix`: MCP-enabled extension with tools and MCP stdio server.

Install the MCP build:

```powershell
code --install-extension .\at-terminal-mcp-0.2.9.vsix
```

For Kiro or Cursor, install the VSIX through the IDE's extension UI or command line if the IDE provides a compatible VSIX install command.

After installation, the MCP server path is inside the installed extension directory, for example:

```text
%USERPROFILE%\.vscode\extensions\local.at-terminal-mcp-0.2.9\dist\mcp-server.js
%USERPROFILE%\.kiro\extensions\local.at-terminal-mcp-0.2.9\dist\mcp-server.js
%USERPROFILE%\.cursor\extensions\local.at-terminal-mcp-0.2.9\dist\mcp-server.js
```

Use the path that matches the IDE where the VSIX is installed.

## Automatic MCP Config

Run this command from the Command Palette:

```text
AT Terminal: Install MCP Config
```

The command:

- Updates Kiro user MCP config at `~/.kiro/settings/mcp.json`.
- Creates Continue workspace MCP config at `.continue/mcpServers/at-terminal.yaml` when a workspace folder is open.
- Uses the current installed extension path, so it fixes stale paths such as `.vscode/extensions/...` when the extension is actually installed under `.kiro/extensions/...`.

The command is only contributed by the MCP build. It is not present in the base build.

## Kiro MCP Config

Kiro supports JSON MCP config at:

- Workspace: `.kiro/settings/mcp.json`
- User: `~/.kiro/settings/mcp.json`

Example user config:

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.9/dist/mcp-server.js"
      ],
      "autoApprove": [
        "list_ssh_servers",
        "get_terminal_context",
        "sftp_list_directory",
        "sftp_stat_path",
        "sftp_read_file"
      ]
    }
  }
}
```

You may include write tools in `autoApprove`, but the extension still applies its own write authorization:

```json
[
  "run_remote_command",
  "sftp_write_file",
  "sftp_create_file",
  "sftp_create_directory"
]
```

Recommended Kiro test prompts:

```text
Use the AT Terminal MCP tool list_ssh_servers to list my configured SSH servers.
Use get_terminal_context to show my AT Terminal context.
Use sftp_list_directory to list /tmp on the connected AT Terminal server.
Use sftp_read_file to read /etc/os-release on the connected AT Terminal server.
```

If Kiro reports `MODULE_NOT_FOUND`, check that the configured `args[0]` path points to the installed extension directory for Kiro, not VS Code.

## Cursor MCP Config

Cursor supports JSON MCP config at:

- Project: `.cursor/mcp.json`
- Global: `~/.cursor/mcp.json`

Example global config:

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.2.9/dist/mcp-server.js"
      ]
    }
  }
}
```

Cursor also supports variable interpolation. A project-local example:

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "${userHome}/.cursor/extensions/local.at-terminal-mcp-0.2.9/dist/mcp-server.js"
      ]
    }
  }
}
```

Restart Cursor or reload MCP servers after editing `mcp.json`. Keep the Cursor window with AT Terminal MCP running so the localhost bridge is available.

## Continue MCP Config

Continue workspace config example:

```yaml
name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - C:/Users/alan/.vscode/extensions/local.at-terminal-mcp-0.2.9/dist/mcp-server.js
```

The sample file in this repo is:

```text
docs/mcp/continue-at-terminal-mcp.yaml
```

## GitHub Copilot Chat In VS Code

GitHub Copilot Chat can discover the VS Code language model tools contributed by the MCP build. After installing `at-terminal-mcp-0.2.9.vsix`, open Copilot Chat Agent mode and reference a tool directly:

```text
Use #list_ssh_servers to list my AT Terminal SSH servers.
Use #get_terminal_context to show my AT Terminal context.
Use #sftp_read_file to read /etc/os-release from the connected AT Terminal server.
```

If Copilot does not show the tools:

1. Confirm the MCP build is installed, not the base build.
2. Reload the IDE window.
3. Open the AT Terminal activity bar view once to activate the extension.
4. Check that `package.json` for the installed extension includes `contributes.languageModelTools`.

## Common Workflows

### List Servers

Ask the agent:

```text
Use list_ssh_servers to show my configured AT Terminal SSH servers.
```

The result includes server id, label, host, port, username, and auth type. It does not include passwords or private key contents.

### Inspect Connected Terminal Context

Ask:

```text
Use get_terminal_context to show which AT Terminal SSH terminal is connected.
```

Use the returned `terminalId` when you need a specific connection.

### Run A Remote Command

Ask:

```text
Use run_remote_command on serverId active to run uname -a.
```

The extension will show a confirmation prompt before executing the command.

### Read A Remote File

Ask:

```text
Use sftp_read_file to read /etc/os-release from the default connected terminal.
```

### Write A Remote File

Ask:

```text
Use sftp_create_file to create /tmp/at-terminal-agent-test.txt with content hello.
```

The first write to that server will ask for write authorization.

## Base AT Terminal Features

The MCP build still includes the base AT Terminal functionality:

- Add, edit, delete, refresh, and copy SSH server connection information.
- Connect, disconnect, and reconnect SSH terminal tabs.
- Password and private-key authentication.
- Unknown host trust prompts and changed host key blocking.
- SFTP directory browsing.
- SFTP upload and drag upload from VS Code Explorer.
- SFTP download of files and folders.
- SFTP new file, new folder, rename, delete, copy path, and preview.
- SFTP remote file editing with upload-on-save.
- Terminal font, scrollback, semantic highlighting, and keep-alive settings.
- Conservative `rz` and `sz` transfer sequence detection for environments with `lrzsz`.

## Development

Install dependencies:

```powershell
npm install
```

Build and test:

```powershell
npm run typecheck
npm test
npm run build:base
npm run build:mcp
```

Package:

```powershell
npm run package:base
npm run package:mcp
```

The packaging script stages each variant under `.package-work/`:

- base variant: uses `package.base.json`, excludes `dist/mcp-server.js`, and packages `README-base.md` as `README.md`.
- MCP variant: uses `package.mcp.json`, includes `dist/mcp-server.js`, installs `@modelcontextprotocol/sdk`, and packages this README.

## Manual Verification Checklist

Use a disposable SSH server or test VM where possible.

- Install `at-terminal-0.2.9.vsix` and confirm no MCP language model tools are contributed.
- Install `at-terminal-mcp-0.2.9.vsix` and confirm MCP tools are contributed.
- Add an SSH server using password auth.
- Add an SSH server using private-key auth.
- Connect an SSH terminal.
- Verify `list_ssh_servers`.
- Verify `get_terminal_context`.
- Verify `run_remote_command` asks before execution.
- Verify `sftp_list_directory`.
- Verify `sftp_stat_path`.
- Verify `sftp_read_file`.
- Verify first-write authorization for `sftp_write_file`, `sftp_create_file`, and `sftp_create_directory`.
- Run `AT Terminal: Install MCP Config` in Kiro and confirm `~/.kiro/settings/mcp.json` points at the Kiro extension path.
- Configure Cursor `.cursor/mcp.json` or `~/.cursor/mcp.json` and confirm Cursor lists the AT Terminal MCP server.
- Confirm base SSH terminal and SFTP UI workflows still work.

