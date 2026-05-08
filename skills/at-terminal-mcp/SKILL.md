---
name: at-terminal-mcp
description: Use when an agent needs to work through AT Terminal MCP for configured SSH servers, active remote terminals, non-interactive remote commands, or SFTP inspection and edits in MCP-capable IDEs such as Kiro, Cursor, Continue, VS Code, or other third-party agents.
---

# AT Terminal MCP

## Overview

Use AT Terminal MCP as the bridge between an agent and the user's already-configured SSH/SFTP sessions. The MCP stdio server never reads passwords, private keys, or server config directly; it connects back to the running AT Terminal MCP extension, where credentials, host-key behavior, terminal state, and confirmations stay inside the IDE.

## Preconditions

Before using tools, ensure the user has installed the MCP build, not the base build: `at-terminal-mcp-*.vsix`.

Keep the IDE window with AT Terminal MCP running and activated. The MCP client starts `node dist/mcp-server.js`, but that sidecar must connect to the local bridge inside the extension host.

For Kiro and Continue, prefer the command palette action `AT Terminal: Install MCP Config`. Manual configs must point to the installed extension's absolute `dist/mcp-server.js` path. If `MODULE_NOT_FOUND` appears, the path usually points at the wrong IDE extension directory.

## MCP Configuration

If MCP is not configured, do not stop at instructions. Scan the current IDE/workspace MCP config and update it yourself when filesystem access allows it.

1. Find the installed MCP server path by checking likely extension folders for `local.at-terminal-mcp-*/dist/mcp-server.js`, such as `~/.kiro/extensions`, `~/.cursor/extensions`, and `~/.vscode/extensions`. Use the path for the IDE that will host the running AT Terminal MCP window.
2. If no installed path is found, ask the user to install `at-terminal-mcp-*.vsix` or provide the absolute `dist/mcp-server.js` path.
3. Add or replace a server named `AT Terminal` or `at-terminal` in the relevant config file.
4. Restart or refresh the MCP client after changing config, then verify by calling `list_ssh_servers` or `get_terminal_context`.

Common config targets:

| Client | Config file | Shape |
| --- | --- | --- |
| Kiro | workspace `.kiro/settings/mcp.json` or user `~/.kiro/settings/mcp.json` | JSON `mcpServers` object |
| Cursor | workspace `.cursor/mcp.json` or user `~/.cursor/mcp.json` | JSON `mcpServers` object |
| Continue | workspace `.continue/mcpServers/at-terminal.yaml` | YAML `mcpServers` list |

Kiro/Cursor JSON:

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": ["C:/ABSOLUTE/PATH/TO/local.at-terminal-mcp-0.2.13/dist/mcp-server.js"]
    }
  }
}
```

Continue YAML:

```yaml
name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - C:/ABSOLUTE/PATH/TO/local.at-terminal-mcp-0.2.13/dist/mcp-server.js
```

## Tool Selection

| Need | Use | Notes |
| --- | --- | --- |
| See configured server ids | `list_ssh_servers` | Read-only; returns labels and connection metadata without credentials. |
| Resolve active/focused SSH session | `get_terminal_context` | Use first when the user says "current", "active", "connected", or does not name a server. |
| Run remote shell work | `run_remote_command` | Non-interactive commands only. Include `serverId`, or use `active` when appropriate. Use `cwd`, `timeoutMs`, and `maxOutputBytes` for bounded runs. |
| Browse remote folders | `sftp_list_directory` | Read-only; pass `serverId` or `terminalId` when more than one session exists. |
| Inspect metadata | `sftp_stat_path` | Read-only existence/type/size checks before edits. |
| Read text files | `sftp_read_file` | Bounded UTF-8 text only; binary-looking content may be rejected. |
| Write or create files | `sftp_write_file`, `sftp_create_file`, `sftp_create_directory` | AT Terminal prompts for first write authorization per server. Use `overwrite: true` only when replacement is intended. |

## Workflow

1. Start with `get_terminal_context` unless the user explicitly names a server id.
2. For remote commands, keep commands non-interactive and specific. Avoid prompts, long-running TUI programs, editors, password entry, and unbounded log tails.
3. For file changes, inspect first with `sftp_stat_path` or `sftp_read_file`, then write the smallest necessary content. Preserve remote POSIX paths exactly.
4. Report stdout, stderr, exit code, timeout, duration, and truncation status when relevant. If output is truncated, rerun with a narrower command before drawing conclusions.

## Remote Command Rules

Always include a POSIX shell comment at the top of every `run_remote_command.command` value so the VS Code or AT Terminal confirmation popup shows the command purpose:

```sh
# Purpose: check disk usage for the target deployment directory
du -sh /srv/app
```

For dangerous commands, wait for the user to approve the AT Terminal or VS Code confirmation dialog before continuing, and do not interpret lack of approval as success. Dangerous commands include deletion, overwrite, permission or ownership changes, service restarts, package installs/upgrades/removals, migrations, firewall/network changes, account changes, process kills, `sudo`, `rm`, `mv` over existing paths, `chmod`, `chown`, `systemctl`, `docker compose down`, and any command that can interrupt production traffic or destroy data.

Prefer read-only inspection before dangerous actions. When a dangerous action is necessary, make the `# Purpose:` comment specific enough that the popup explains the effect, target path/service, and reason.

## Common Mistakes

- Do not try to read local AT Terminal secrets or VS Code storage. Use MCP tools only.
- Do not assume "active" is correct when multiple terminals are connected. Check `get_terminal_context`.
- Do not use `run_remote_command` for interactive shells, `sudo` password prompts, pagers, editors, or file transfer.
- Do not add write tools to auto-approval as a safety substitute. AT Terminal still enforces first write authorization, and destructive remote edits still require clear user intent.
- Do not confuse the base `AT Terminal` package with `AT Terminal MCP`; the base package has no `dist/mcp-server.js`.
