# Usage Guide

This guide covers day-to-day AT Terminal MCP usage, installation, MCP configuration, and development commands.

## Basic Usage

1. Open the AT Terminal activity bar view.
2. Run `SSH: Add Server`.
3. Enter host, port, username, and authentication settings.
4. Save the server.
5. Connect from the `Servers` view.
6. Use `SFTP Files` to browse and manage remote files.
7. Use `SFTP: Edit` to edit a remote file locally and sync on save.

## Install And Package

```powershell
npm install
npm run package:base
npm run package:mcp
```

Generated files:

- `at-terminal-2.10.2.vsix`: base extension without MCP tools.
- `at-terminal-mcp-2.10.2.vsix`: MCP-enabled extension with tools and stdio MCP server.

Install the MCP build:

```powershell
code --install-extension .\at-terminal-mcp-2.10.2.vsix
```

For Kiro and Cursor, install the VSIX through the IDE's extension UI or compatible command-line installer.

## Automatic MCP Config

Run this command from the Command Palette:

```text
AT Terminal: Install MCP Config
```

It:

- Updates the current IDE MCP config, such as Kiro's `~/.kiro/settings/mcp.json` or Cursor's `~/.cursor/mcp.json`.
- Creates Continue workspace config at `.continue/mcpServers/at-terminal.yaml` when a workspace is open.
- Uses the installed extension path from the current IDE, so Kiro, Cursor, and other IDEs do not accidentally point at each other's extension directories.

If automatic config fails, the MCP config for each IDE only needs `args[0]` to point at `dist/mcp-server.js` inside that IDE's installed AT Terminal MCP extension directory. The `command`, MCP server name, and tool settings are otherwise the same.

How to find the extension directory in VS Code-compatible IDEs:

1. Open the Command Palette in the target IDE.
2. Search for and run `Open Extensions Folder`.
3. Find `local.at-terminal-mcp-<version>` or `at-terminal-mcp-<version>`.
4. Confirm that `dist/mcp-server.js` exists in that folder, then use its full path in `args`.

## Tool Targeting

- Pass `terminalId` to target a specific connected AT Terminal tab.
- Pass `serverId` to target a connected terminal for that server.
- Omit both to use `defaultConnectedTerminal`.
- Use `get_terminal_context` first when unsure.

## Kiro

Kiro supports:

- Workspace config: `.kiro/settings/mcp.json`
- User config: `~/.kiro/settings/mcp.json`

Example:

```json
{
  "name": "AT Terminal MCP",
  "version": "0.0.1",
  "schema": "v1",
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "<AT Terminal MCP extension directory>/dist/mcp-server.js"
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

If you add write tools to `autoApprove`, AT Terminal MCP still applies its own write authorization:

```json
[
  "run_remote_command",
  "sftp_write_file",
  "sftp_create_file",
  "sftp_create_directory"
]
```

Kiro test prompts:

```text
Use the AT Terminal MCP tool list_ssh_servers to list my configured SSH servers.
Use get_terminal_context to show my AT Terminal context.
Use sftp_list_directory to list /tmp on the connected AT Terminal server.
Use sftp_read_file to read /etc/os-release on the connected AT Terminal server.
```

If you see `MODULE_NOT_FOUND`, check whether `args[0]` points at the extension directory for the current IDE. Kiro should point at Kiro's extension directory, Cursor should point at Cursor's extension directory, and they should not reuse each other's `.vscode/extensions`, `.cursor/extensions`, or `.kiro/extensions` paths.

## Cursor

Cursor supports:

- Project config: `.cursor/mcp.json`
- Global config: `~/.cursor/mcp.json`

Example:

```json
{
  "name": "AT Terminal MCP",
  "version": "0.0.1",
  "schema": "v1",
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "<AT Terminal MCP extension directory>/dist/mcp-server.js"
      ],
      "autoApprove": [
        "list_ssh_servers",
        "get_terminal_context",
        "run_remote_command",
        "sftp_list_directory",
        "sftp_stat_path",
        "sftp_read_file",
        "sftp_write_file",
        "sftp_create_file",
        "sftp_create_directory"
      ]
    }
  }
}
```

Project-local example with variables:

```json
{
  "name": "AT Terminal MCP",
  "version": "0.0.1",
  "schema": "v1",
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "${userHome}/.cursor/extensions/local.at-terminal-mcp-2.10.2/dist/mcp-server.js"
      ],
      "autoApprove": [
        "list_ssh_servers",
        "get_terminal_context",
        "run_remote_command",
        "sftp_list_directory",
        "sftp_stat_path",
        "sftp_read_file",
        "sftp_write_file",
        "sftp_create_file",
        "sftp_create_directory"
      ]
    }
  }
}
```

Restart Cursor or refresh MCP servers after editing the config. Keep the Cursor window with AT Terminal MCP running so the MCP server can connect to the local bridge.

## Continue

Workspace example:

```yaml
name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - "<AT Terminal MCP extension directory>/dist/mcp-server.js"
```

The repository also includes this sample file:

```text
docs/mcp/continue-at-terminal-mcp.yaml
```

## GitHub Copilot Chat

After installing `at-terminal-mcp-2.10.2.vsix` in VS Code, Copilot Chat Agent mode can discover the contributed language model tools.

Example prompts:

```text
Use #list_ssh_servers to list my AT Terminal SSH servers.
Use #get_terminal_context to show my AT Terminal context.
Use #sftp_read_file to read /etc/os-release from the connected AT Terminal server.
```

If Copilot cannot see the tools:

1. Confirm that the MCP build is installed, not the base build.
2. Reload Window.
3. Open the AT Terminal activity bar view once to activate the extension.
4. Check that the installed extension's `package.json` contains `contributes.languageModelTools`.

## Commands

Server commands:

- `SSH: Add Server`
- `SSH: Edit Server`
- `SSH: Delete Server`
- `SSH: Connect`
- `SSH: Disconnect`
- `SSH: Reconnect`
- `SSH: Copy Host`
- `SSH: Refresh`

SFTP commands:

- `SFTP: Refresh`
- `SFTP: Upload`
- `SFTP: Download`
- `SFTP: Delete`
- `SFTP: Rename`
- `SFTP: New File`
- `SFTP: New Folder`
- `SFTP: Copy Remote Path`
- `SFTP: Edit`
- `SFTP: Open Preview`
- `SFTP: cd To Directory`
- `SFTP: Go to Path`
- `SFTP: Go Up`

Asset commands:

- `AT Terminal: Export Assets`
- `AT Terminal: Import Assets`

MCP command:

- `AT Terminal: Install MCP Config`

## Settings

- `sshManager.terminalFontSize`: terminal font size.
- `sshManager.terminalFontFamily`: terminal font family.
- `sshManager.scrollback`: terminal scrollback lines.
- `sshManager.semanticHighlight`: enables frontend semantic highlighting for plain SSH output without ANSI colors.
- `sshManager.keepAliveInterval`: SSH keep-alive interval in seconds. `0` disables keep-alive.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run package:base
npm run package:mcp
```
