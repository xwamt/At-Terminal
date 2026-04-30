# AT Terminal MCP Manual Test

## Preconditions

- AT Terminal extension is installed from the current VSIX.
- VS Code has been reloaded after installation.
- At least one AT Terminal SSH server is configured.
- Continue is installed and set to Agent mode.

## Continue Setup

Create `.continue/mcpServers/at-terminal.yaml` in a workspace:

```yaml
name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - C:/Users/alan/.vscode/extensions/local.at-terminal-0.2.9/dist/mcp-server.js
```

Adjust the path to the actual installed extension directory.

## Cases

1. Ask Continue Agent: `Use the AT Terminal MCP tool to list SSH servers.`
   - Expected: Continue uses `list_ssh_servers`.
   - Expected: output includes AT Terminal configured servers.
   - Expected: output does not include passwords or private key contents.

2. Ask Continue Agent: `Use run_remote_command to run pwd on serverId active.`
   - Expected: AT Terminal extension shows a confirmation prompt in VS Code.
   - Expected: approving returns stdout, stderr, exitCode, timedOut, and truncated.

3. Close VS Code or disable AT Terminal, then ask Continue to list servers.
   - Expected: MCP returns a clear error saying the AT Terminal MCP bridge is not running.
