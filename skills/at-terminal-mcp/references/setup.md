# MCP Setup

Read this reference only when AT Terminal MCP is unavailable, disconnected, or incorrectly configured.

## Preconditions

- Install the MCP build, `at-terminal-mcp-*.vsix`; the base build does not publish an AT Series bridge or sync `hub.js`.
- Keep the IDE window containing AT Terminal MCP running and activated so the extension can publish its bridge into `~/.at-series`.
- Prefer the command-palette action `AT Terminal: Install MCP Config` for Kiro, Cursor, and Continue. It writes an **AT Series** MCP entry that points at `~/.at-series/mcp/hub.js`.

## Recovery workflow

1. Confirm AT Terminal MCP is installed and the IDE window is running.
2. Run `AT Terminal: Install MCP Config`, or manually add an MCP server named `AT Series` that runs `node` against `~/.at-series/mcp/hub.js`.
3. If `hub.js` is missing, reload the IDE window with AT Terminal MCP installed so hub sync can elect the packaged `dist/hub.js`.
4. Restart or refresh the MCP client.
5. Verify with `at_list_providers`, then `at_select_tools` for `at.terminal`, then `get_terminal_context` or `list_ssh_servers`.

Common configuration targets:

| Client | Configuration |
| --- | --- |
| Kiro | workspace `.kiro/settings/mcp.json` or user `~/.kiro/settings/mcp.json` |
| Cursor | workspace `.cursor/mcp.json` or user `~/.cursor/mcp.json` |
| Continue | workspace `.continue/mcpServers/at-terminal.yaml` |

Kiro/Cursor shape:

```json
{
  "mcpServers": {
    "AT Series": {
      "command": "node",
      "args": ["C:/Users/YOU/.at-series/mcp/hub.js"],
      "env": {
        "AT_SERIES_HOST_APP": "cursor",
        "AT_SERIES_TOOL_DISCOVERY": "auto",
        "AT_SERIES_TOOL_DISCOVERY_THRESHOLD": "20",
        "AT_SERIES_TOOL_SELECTION_IDLE_MS": "0",
        "AT_SERIES_TOOL_SELECTION_MAX_CALLS": "0"
      },
      "autoApprove": [
        "at_list_providers",
        "at_search_tools",
        "at_get_tool",
        "at_select_tools",
        "at_clear_tool_selection"
      ]
    }
  }
}
```

Continue shape:

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

When editing client configuration, preserve unrelated servers and settings. Do not enable write-tool auto-approval as a substitute for operational safety.
