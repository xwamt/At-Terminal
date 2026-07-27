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

- `at-terminal-*.vsix`: base extension without MCP bridge / hub.
- `at-terminal-mcp-*.vsix`: MCP-enabled extension with AT Series hub packaging and bridge.

Install the MCP build:

```powershell
code --install-extension .\at-terminal-mcp-0.2.17.vsix
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
- Writes an **AT Series** MCP server entry that runs `node` against `~/.at-series/mcp/hub.js` (and migrates legacy per-plugin `AT Terminal` entries away).
- Default `autoApprove` covers hub builtins and read-risk tools only; `run_remote_command` (exec) and SFTP write/create tools stay out of auto-approve.

If automatic config fails, point the IDE MCP client at the shared hub (AT Series only — do not point at a per-plugin `mcp-server.js`):

```json
{
  "mcpServers": {
    "AT Series": {
      "command": "node",
      "args": ["C:/Users/YOU/.at-series/mcp/hub.js"],
      "env": {
        "AT_SERIES_HOST_APP": "cursor"
      }
    }
  }
}
```

Keep the IDE window with AT Terminal MCP running so the extension can publish its bridge into `~/.at-series` and elect `hub.js`.

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
  "mcpServers": {
    "AT Series": {
      "command": "node",
      "args": [
        "C:/Users/YOU/.at-series/mcp/hub.js"
      ],
      "env": {
        "AT_SERIES_HOST_APP": "kiro"
      },
      "autoApprove": [
        "at_list_providers",
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
Use the AT Series / AT Terminal tool list_ssh_servers to list my SSH servers authorized for background connections.
Use get_terminal_context to show my AT Terminal context.
Use sftp_list_directory to list /tmp on the connected AT Terminal server.
Use sftp_read_file to read /etc/os-release on the connected AT Terminal server.
```

## Cursor

Cursor supports:

- Project config: `.cursor/mcp.json`
- Global config: `~/.cursor/mcp.json`

Example:

```json
{
  "mcpServers": {
    "AT Series": {
      "command": "node",
      "args": [
        "${userHome}/.at-series/mcp/hub.js"
      ],
      "env": {
        "AT_SERIES_HOST_APP": "cursor"
      },
      "autoApprove": [
        "at_list_providers",
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

Restart Cursor or refresh MCP servers after editing the config. Keep the Cursor window with AT Terminal MCP running so the hub can reach the local bridge.

## Continue

Workspace example:

```yaml
name: AT Series
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Series
    command: node
    args:
      - ${userHome}/.at-series/mcp/hub.js
    env:
      AT_SERIES_HOST_APP: continue
```

The repository also includes this sample file:

```text
docs/mcp/continue-at-terminal-mcp.yaml
```

## Agent Access

After installing `at-terminal-mcp-*.vsix`, configure the IDE MCP client for **AT Series** (prefer `AT Terminal: Install MCP Config`). Tools such as `list_ssh_servers`, `get_terminal_context`, and SFTP helpers are exposed through the shared hub rather than VS Code built-in LM tool contributions.

Example prompts:

```text
Use list_ssh_servers to list my AT Terminal SSH servers.
Use get_terminal_context to show my AT Terminal context.
Use sftp_read_file to read /etc/os-release from the connected AT Terminal server.
```

If tools are missing:

1. Confirm that the MCP build is installed, not the base build.
2. Reload Window and keep AT Terminal MCP activated.
3. Run `AT Terminal: Install MCP Config`.
4. Confirm `~/.at-series/mcp/hub.js` exists and the MCP entry is named `AT Series`.

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

MCP commands:

- `AT Terminal: Install MCP Config`
- `AT Terminal: Uninstall AT Series MCP Config`

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
