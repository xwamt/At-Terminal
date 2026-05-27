# AT Terminal MCP

![AT Terminal icon](media/at-terminal-icon.png)

AT Terminal MCP is the agent-enabled build of AT Terminal, an SSH terminal and SFTP workspace extension for VS Code-compatible IDEs. It keeps the base SSH terminal, SFTP file management, and local editing workflow for remote files, and adds VS Code language model tools plus a local stdio MCP server for agent workflows.

Install the base `AT Terminal` build if you only need SSH and SFTP. Install `AT Terminal MCP` when you want GitHub Copilot Chat, Kiro, Cursor, Continue, or another MCP-capable IDE agent to run confirmed remote commands or read and write remote files through AT Terminal.

## Documentation

- [Features](docs/features.md)
- [Usage Guide](docs/usage.md)
- [MCP setup example for Continue](docs/mcp/continue-at-terminal-mcp.yaml)
- [Agent skill guidance](skills/at-terminal-mcp/SKILL.md)
- [Chinese documentation](docs/README.zh-CN.md)

## Highlights

- Agentless SSH terminal and SFTP workspace for VS Code-compatible IDEs.
- Local editing for remote files with upload-on-save.
- VS Code language model tools for GitHub Copilot Chat and compatible agents.
- Local stdio MCP server for Kiro, Cursor, Continue, and other MCP clients.
- Remote command execution with AT Terminal confirmation and trust controls.
- Bounded SFTP read tools and explicit write authorization for remote file changes.
- Encrypted asset import and export for moving server configuration between supported IDEs or devices.

## How It Works

The MCP server does not read AT Terminal passwords, private keys, or server configuration directly. Tool calls go through the running AT Terminal MCP extension:

1. The extension starts inside VS Code, Kiro, Cursor, or another compatible IDE.
2. The extension starts a localhost bridge and writes a discovery file.
3. The MCP client starts the stdio server with `node dist/mcp-server.js`.
4. The MCP server connects back to the local bridge.
5. The extension handles tool calls using existing AT Terminal configuration, SecretStorage credentials, host key verification, and confirmation prompts.

Keep the IDE window with AT Terminal MCP running before using MCP tools.

## Builds

| Capability | Base `AT Terminal` | `AT Terminal MCP` |
| --- | --- | --- |
| SSH terminal and SFTP workspace | Yes | Yes |
| Remote file local edit workflow | Yes | Yes |
| VS Code language model tools | No | Yes |
| Local stdio MCP server | No | Yes |
| Agent skill guidance | No | Yes |

## Development

```powershell
npm install
npm run typecheck
npm test
npm run package:base
npm run package:mcp
```

Generated VSIX files:

- `at-terminal-2.10.2.vsix`: base extension without MCP tools.
- `at-terminal-mcp-2.10.2.vsix`: MCP-enabled extension with tools and stdio MCP server.

Packaging rules:

- The base variant uses `package.base.json`, excludes `dist/mcp-server.js`, and packages `README-base.md` as the VSIX `README.md`.
- The MCP variant uses `package.mcp.json`, includes `dist/mcp-server.js` and `@modelcontextprotocol/sdk`, and packages this README.
- Documentation links and images stay relative so they work in the repository and packaged VSIX.
