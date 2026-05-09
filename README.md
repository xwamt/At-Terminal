# AT Terminal MCP

[中文](#中文) | [English](#english)

![AT Terminal icon](media/at-terminal-icon.png)

## 中文

AT Terminal MCP 是 AT Terminal 的 MCP 增强版。它保留基础版的 SSH 终端、SFTP 文件管理和远程文件本地编辑能力，同时增加：

- VS Code language model tools，供 GitHub Copilot Chat 和其他 VS Code Agent 调用。
- 本地 MCP stdio server，供 Kiro、Cursor、Continue 和其他支持 MCP 的 VS Code 系列 IDE 调用。

如果你只需要 SSH/SFTP 功能，请安装基础版 `AT Terminal`。如果你需要让 IDE Agent 调用远程命令或 SFTP 工具，请安装 `AT Terminal MCP`。

### 工作方式

MCP server 不直接读取 AT Terminal 的密码、私钥或服务器配置。实际调用链是：

1. AT Terminal MCP 扩展在 VS Code/Kiro/Cursor 等 IDE 中启动。
2. 扩展启动一个本地 localhost bridge，并写入发现文件。
3. Kiro、Cursor、Continue 等 MCP Client 通过 `node dist/mcp-server.js` 启动 stdio MCP server。
4. MCP server 连接回本地 bridge。
5. 扩展使用已有的 AT Terminal 配置、SecretStorage、主机指纹校验和确认弹窗执行工具调用。

因此，使用 MCP 工具前，需要保持安装了 AT Terminal MCP 的 IDE 窗口处于运行状态，并激活过扩展。

### 工具列表

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `list_ssh_servers` | 只读 | 列出 AT Terminal 中配置的 SSH 服务器，不暴露密码和私钥。 |
| `get_terminal_context` | 只读 | 返回当前聚焦终端、默认连接终端、已连接终端和已知终端上下文。 |
| `run_remote_command` | 命令 | 通过 SSH 执行非交互命令，返回 stdout、stderr、exit code、超时和截断信息。 |
| `sftp_list_directory` | 只读 | 通过已连接的 AT Terminal SFTP 会话列出远程目录。 |
| `sftp_stat_path` | 只读 | 返回远程文件或目录元信息。 |
| `sftp_read_file` | 只读 | 读取有限大小的 UTF-8 远程文本文件，二进制内容会被拒绝。 |
| `sftp_write_file` | 写入 | 写入 UTF-8 文本到远程文件，覆盖已有文件需要 `overwrite: true`。 |
| `sftp_create_file` | 写入 | 创建远程文件，可选写入 UTF-8 内容。 |
| `sftp_create_directory` | 写入 | 创建远程目录。 |

安全策略：

- `run_remote_command` 每次执行前都会弹确认。
- SFTP 写入工具在当前扩展宿主会话内，对每台服务器首次写入时弹确认。
- 只读工具不会返回密码、私钥或 SecretStorage 内容。
- SFTP 读取有大小上限，避免把大文件直接灌进聊天上下文。
- 写入工具会解析远程路径，并禁止修改远程根路径。

目标选择：

- 传 `terminalId`：指定某个已连接 AT Terminal 标签页。
- 传 `serverId`：指定某台服务器对应的已连接终端。
- 两者都不传：使用 `defaultConnectedTerminal`。
- 不确定时，先调用 `get_terminal_context`。

### 安装和打包

```powershell
npm install
npm run package:base
npm run package:mcp
```

生成：

- `at-terminal-0.2.14.vsix`: 基础版，不含 MCP 工具。
- `at-terminal-mcp-0.2.14.vsix`: MCP 版，包含 Agent 工具和 stdio MCP server。

安装 MCP 版：

```powershell
code --install-extension .\at-terminal-mcp-0.2.14.vsix
```

Kiro、Cursor 等 IDE 可以通过各自的扩展安装入口安装 VSIX。

### 自动写入 MCP 配置

安装 MCP 版后，在命令面板运行：

```text
AT Terminal: Install MCP Config
```

它会：

- 更新 Kiro 用户级配置 `~/.kiro/settings/mcp.json`。
- 如果当前打开了 workspace，则创建 Continue 配置 `.continue/mcpServers/at-terminal.yaml`。
- 使用当前扩展真实安装路径，避免 Kiro 中误指向 `.vscode/extensions/...`。

### Kiro 配置

Kiro 支持：

- workspace 配置：`.kiro/settings/mcp.json`
- 用户配置：`~/.kiro/settings/mcp.json`

示例：

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.14/dist/mcp-server.js"
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

如果你把写入工具加入 `autoApprove`，AT Terminal MCP 扩展仍会执行自己的写入授权：

```json
[
  "run_remote_command",
  "sftp_write_file",
  "sftp_create_file",
  "sftp_create_directory"
]
```

Kiro 测试提示词：

```text
Use the AT Terminal MCP tool list_ssh_servers to list my configured SSH servers.
Use get_terminal_context to show my AT Terminal context.
Use sftp_list_directory to list /tmp on the connected AT Terminal server.
Use sftp_read_file to read /etc/os-release on the connected AT Terminal server.
```

如果出现 `MODULE_NOT_FOUND`，检查 `args[0]` 是否指向 Kiro 的扩展安装目录，例如 `.kiro/extensions/local.at-terminal-mcp-0.2.14/dist/mcp-server.js`，不要误指向 VS Code 的 `.vscode/extensions`。

### Cursor 配置

Cursor 支持：

- 项目配置：`.cursor/mcp.json`
- 全局配置：`~/.cursor/mcp.json`

示例：

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.2.14/dist/mcp-server.js"
      ]
    }
  }
}
```

项目内也可以使用变量：

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "${userHome}/.cursor/extensions/local.at-terminal-mcp-0.2.14/dist/mcp-server.js"
      ]
    }
  }
}
```

修改后重启 Cursor 或刷新 MCP server。保持安装了 AT Terminal MCP 的 Cursor 窗口运行，MCP server 才能连接本地 bridge。

### Continue 配置

Continue workspace 示例：

```yaml
name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - C:/Users/alan/.vscode/extensions/local.at-terminal-mcp-0.2.14/dist/mcp-server.js
```

仓库内示例文件：

```text
docs/mcp/continue-at-terminal-mcp.yaml
```

### GitHub Copilot Chat

在 VS Code 中安装 `at-terminal-mcp-0.2.14.vsix` 后，Copilot Chat Agent mode 可以发现 language model tools。

示例提示词：

```text
Use #list_ssh_servers to list my AT Terminal SSH servers.
Use #get_terminal_context to show my AT Terminal context.
Use #sftp_read_file to read /etc/os-release from the connected AT Terminal server.
```

如果 Copilot 看不到工具：

1. 确认安装的是 MCP 版，不是基础版。
2. Reload Window。
3. 打开一次 AT Terminal 活动栏视图激活扩展。
4. 检查安装目录下 `package.json` 是否包含 `contributes.languageModelTools`。

### 基础功能

MCP 版仍包含基础版能力：

- SSH 服务器管理。
- 密码和私钥认证。
- 主机指纹确认和变更阻断。
- SSH 终端标签页。
- SFTP 浏览、上传、下载、拖拽上传。
- SFTP 新建、重命名、删除、复制路径和预览。
- SFTP 远程文件本地编辑并保存同步。
- 终端字体、滚动缓冲、语义高亮和 keep-alive 设置。
- `rz`/`sz` 序列检测。

### 开发和验证

```powershell
npm install
npm run typecheck
npm test
npm run package:base
npm run package:mcp
```

打包规则：

- base variant 使用 `package.base.json`，排除 `dist/mcp-server.js`，并把 `README-base.md` 打进 VSIX 内的 `README.md`。
- MCP variant 使用 `package.mcp.json`，包含 `dist/mcp-server.js` 和 `@modelcontextprotocol/sdk`，并把本 README 打进 VSIX。
- README 图片保持相对路径，并随 VSIX 打入 `media/` 和 `docs/images/`。

## English

AT Terminal MCP is the MCP-enabled build of AT Terminal. It keeps the base SSH terminal, SFTP file management, and local remote-file editing workflow, and adds:

- VS Code language model tools for GitHub Copilot Chat and other VS Code agents.
- A local MCP stdio server for Kiro, Cursor, Continue, and other MCP-capable VS Code-compatible IDEs.

Install the base `AT Terminal` build if you only need SSH/SFTP. Install `AT Terminal MCP` when you want IDE agents to call remote command and SFTP tools.

### How It Works

The MCP server does not read AT Terminal passwords, private keys, or server config directly.

The flow is:

1. The AT Terminal MCP extension starts inside VS Code, Kiro, Cursor, or another compatible IDE.
2. The extension starts a localhost bridge and writes a discovery file.
3. The MCP client starts the stdio server with `node dist/mcp-server.js`.
4. The MCP server connects back to the local bridge.
5. The extension handles tool calls using existing AT Terminal config, SecretStorage credentials, host key verification, and confirmation prompts.

Keep the IDE window with AT Terminal MCP running before using MCP tools.

### Tools

| Tool | Type | Description |
| --- | --- | --- |
| `list_ssh_servers` | read-only | Lists configured SSH servers without exposing passwords or private keys. |
| `get_terminal_context` | read-only | Returns focused, default connected, connected, and known AT Terminal SSH terminal context. |
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
- Read tools do not return passwords, private keys, or SecretStorage values.
- SFTP reads are bounded.
- Write tools resolve remote paths and do not allow modifying the remote root path.

Targeting:

- Pass `terminalId` to target a specific connected AT Terminal tab.
- Pass `serverId` to target a connected terminal for that server.
- Omit both to use `defaultConnectedTerminal`.
- Use `get_terminal_context` first when unsure.

### Install And Package

```powershell
npm install
npm run package:base
npm run package:mcp
```

Generated files:

- `at-terminal-0.2.14.vsix`: base extension without MCP tools.
- `at-terminal-mcp-0.2.14.vsix`: MCP-enabled extension with tools and stdio MCP server.

Install the MCP build:

```powershell
code --install-extension .\at-terminal-mcp-0.2.14.vsix
```

For Kiro and Cursor, install the VSIX through the IDE's extension UI or compatible command-line installer.

### Automatic MCP Config

Run this command from the Command Palette:

```text
AT Terminal: Install MCP Config
```

It:

- Updates Kiro user config at `~/.kiro/settings/mcp.json`.
- Creates Continue workspace config at `.continue/mcpServers/at-terminal.yaml` when a workspace is open.
- Uses the current installed extension path, so Kiro does not accidentally point at `.vscode/extensions/...`.

### Kiro

Kiro supports:

- Workspace config: `.kiro/settings/mcp.json`
- User config: `~/.kiro/settings/mcp.json`

Example:

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.14/dist/mcp-server.js"
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

If you add write tools to `autoApprove`, AT Terminal MCP still applies its own write authorization.

### Cursor

Cursor supports:

- Project config: `.cursor/mcp.json`
- Global config: `~/.cursor/mcp.json`

Example:

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.2.14/dist/mcp-server.js"
      ]
    }
  }
}
```

Project-local example with variables:

```json
{
  "mcpServers": {
    "AT Terminal": {
      "command": "node",
      "args": [
        "${userHome}/.cursor/extensions/local.at-terminal-mcp-0.2.14/dist/mcp-server.js"
      ]
    }
  }
}
```

Restart Cursor or refresh MCP servers after editing the config.

### Continue

Workspace example:

```yaml
name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - C:/Users/alan/.vscode/extensions/local.at-terminal-mcp-0.2.14/dist/mcp-server.js
```

### GitHub Copilot Chat

After installing `at-terminal-mcp-0.2.14.vsix` in VS Code, Copilot Chat Agent mode can discover the contributed language model tools.

Example prompts:

```text
Use #list_ssh_servers to list my AT Terminal SSH servers.
Use #get_terminal_context to show my AT Terminal context.
Use #sftp_read_file to read /etc/os-release from the connected AT Terminal server.
```

### Base AT Terminal Features

The MCP build still includes:

- SSH server management.
- Password and private-key authentication.
- Host key verification and changed-host-key blocking.
- SSH terminal tabs.
- SFTP browse, upload, download, and drag upload.
- SFTP create, rename, delete, copy path, and preview.
- Local editing for remote files with upload-on-save.
- Terminal font, scrollback, semantic highlighting, and keep-alive settings.
- `rz`/`sz` sequence detection.

### Base Vs MCP Build

| Capability | Base `AT Terminal` | `AT Terminal MCP` |
| --- | --- | --- |
| SSH terminal and SFTP workspace | Yes | Yes |
| Remote file local edit workflow | Yes | Yes |
| VS Code language model tools | No | Yes |
| Local stdio MCP server | No | Yes |
| Agent skill guidance | No | Yes |

### Agent Skill

The MCP build includes agent workflow guidance in `skills/at-terminal-mcp/SKILL.md`.

Use `$at-terminal-mcp` when an agent needs to inspect configured AT Terminal sessions, resolve the active terminal context, run confirmed non-interactive remote commands, or read/write remote files through the AT Terminal MCP tools.

### Development

```powershell
npm install
npm run typecheck
npm test
npm run package:base
npm run package:mcp
```

Packaging rules:

- The base variant uses `package.base.json`, excludes `dist/mcp-server.js`, and packages `README-base.md` as the VSIX `README.md`.
- The MCP variant uses `package.mcp.json`, includes `dist/mcp-server.js` and `@modelcontextprotocol/sdk`, and packages this README.
- README images stay as relative links and are packaged under `media/` and `docs/images/`.
