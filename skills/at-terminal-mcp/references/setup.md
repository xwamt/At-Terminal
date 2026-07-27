# MCP Setup

Read this reference only when AT Terminal MCP is unavailable, disconnected, or incorrectly configured.

## Preconditions

- Install the MCP build, `at-terminal-mcp-*.vsix`; the base build has no `dist/mcp-server.js`.
- Keep the IDE window containing AT Terminal MCP running and activated.
- Prefer the command-palette action `AT Terminal: Install MCP Config` for Kiro, Cursor, and Continue.
- The configured script path must belong to the IDE hosting the running extension. `MODULE_NOT_FOUND` usually means the path points to another IDE or extension version.

## Recovery workflow

1. Look for `local.at-terminal-mcp-*/dist/mcp-server.js` under the current IDE's extension directory, such as `~/.kiro/extensions`, `~/.cursor/extensions`, or `~/.vscode/extensions`.
2. If it is absent, ask the user to install the MCP VSIX or provide the absolute server path.
3. Add or replace an MCP server named `AT Terminal` or `at-terminal` in the relevant client configuration.
4. Restart or refresh the MCP client.
5. Verify connectivity with `get_terminal_context` or `list_ssh_servers`.

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
    "AT Terminal": {
      "command": "node",
      "args": ["C:/ABSOLUTE/PATH/TO/local.at-terminal-mcp-VERSION/dist/mcp-server.js"]
    }
  }
}
```

Continue shape:

```yaml
name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - C:/ABSOLUTE/PATH/TO/local.at-terminal-mcp-VERSION/dist/mcp-server.js
```

When editing client configuration, preserve unrelated servers and settings. Do not enable write-tool auto-approval as a substitute for operational safety.
