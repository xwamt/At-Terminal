# 使用教程

这份教程覆盖 AT Terminal MCP 的日常使用、安装打包、MCP 配置和开发命令。

## 基本使用

1. 打开 AT Terminal 活动栏视图。
2. 执行 `SSH: Add Server`。
3. 填写主机、端口、用户名和认证设置。
4. 保存服务器。
5. 从 `Servers` 视图连接服务器。
6. 使用 `SFTP Files` 浏览和管理远程文件。
7. 使用 `SFTP: Edit` 本地编辑远程文件，并在保存时同步回远程路径。

## 安装和打包

```powershell
npm install
npm run package:base
npm run package:mcp
```

生成文件：

- `at-terminal-2.10.2.vsix`：基础版，不包含 MCP 工具。
- `at-terminal-mcp-2.10.2.vsix`：MCP 版，包含工具和 stdio MCP server。

安装 MCP 版：

```powershell
code --install-extension .\at-terminal-mcp-2.10.2.vsix
```

Kiro 和 Cursor 可以通过各自 IDE 的扩展安装入口或兼容命令行安装 VSIX。

## 自动写入 MCP 配置

在命令面板运行：

```text
AT Terminal: Install MCP Config
```

它会：

- 更新当前 IDE 的 MCP 配置，例如 Kiro 的 `~/.kiro/settings/mcp.json` 或 Cursor 的 `~/.cursor/mcp.json`。
- 当前打开 workspace 时，创建 Continue workspace 配置 `.continue/mcpServers/at-terminal.yaml`。
- 使用当前 IDE 中扩展的真实安装路径，避免 Kiro、Cursor 和其他 IDE 之间互相误指向扩展目录。

如果自动配置失败，各 IDE 的 MCP 配置只需要把 `args[0]` 指向当前 IDE 安装的 AT Terminal MCP 扩展目录下的 `dist/mcp-server.js`。`command`、MCP server 名称和工具设置通常保持一致。

在 VS Code 兼容 IDE 中查找扩展目录：

1. 在目标 IDE 中打开命令面板。
2. 搜索并运行 `Open Extensions Folder`。
3. 找到 `local.at-terminal-mcp-<version>` 或 `at-terminal-mcp-<version>`。
4. 确认该目录下存在 `dist/mcp-server.js`，然后在 `args` 中使用完整路径。

## 工具目标选择

- 传入 `terminalId` 可以指定某个已连接的 AT Terminal 标签页。
- 传入 `serverId` 可以指定某台服务器对应的已连接终端。
- 两者都不传时，使用 `defaultConnectedTerminal`。
- 不确定目标时，先使用 `get_terminal_context`。

## Kiro

Kiro 支持：

- Workspace 配置：`.kiro/settings/mcp.json`
- 用户配置：`~/.kiro/settings/mcp.json`

示例：

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

即使把写入工具加入 `autoApprove`，AT Terminal MCP 仍会执行自己的写入授权：

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

如果出现 `MODULE_NOT_FOUND`，检查 `args[0]` 是否指向当前 IDE 的扩展目录。Kiro 应指向 Kiro 的扩展目录，Cursor 应指向 Cursor 的扩展目录，不要复用彼此的 `.vscode/extensions`、`.cursor/extensions` 或 `.kiro/extensions` 路径。

## Cursor

Cursor 支持：

- 项目配置：`.cursor/mcp.json`
- 全局配置：`~/.cursor/mcp.json`

示例：

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

项目内也可以使用变量：

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

修改后重启 Cursor 或刷新 MCP servers。保持安装了 AT Terminal MCP 的 Cursor 窗口运行，MCP server 才能连接本地 bridge。

## Continue

Workspace 示例：

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

仓库内也包含示例文件：

```text
docs/mcp/continue-at-terminal-mcp.yaml
```

## GitHub Copilot Chat

在 VS Code 中安装 `at-terminal-mcp-2.10.2.vsix` 后，Copilot Chat Agent mode 可以发现扩展贡献的 language model tools。

示例提示词：

```text
Use #list_ssh_servers to list my AT Terminal SSH servers.
Use #get_terminal_context to show my AT Terminal context.
Use #sftp_read_file to read /etc/os-release from the connected AT Terminal server.
```

如果 Copilot 看不到工具：

1. 确认安装的是 MCP 版，不是基础版。
2. Reload Window。
3. 打开一次 AT Terminal 活动栏视图以激活扩展。
4. 检查已安装扩展的 `package.json` 是否包含 `contributes.languageModelTools`。

## 命令

服务器命令：

- `SSH: Add Server`
- `SSH: Edit Server`
- `SSH: Delete Server`
- `SSH: Connect`
- `SSH: Disconnect`
- `SSH: Reconnect`
- `SSH: Copy Host`
- `SSH: Refresh`

SFTP 命令：

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

资产命令：

- `AT Terminal: Export Assets`
- `AT Terminal: Import Assets`

MCP 命令：

- `AT Terminal: Install MCP Config`

## 设置

- `sshManager.terminalFontSize`：终端字体大小。
- `sshManager.terminalFontFamily`：终端字体。
- `sshManager.scrollback`：终端滚动缓冲行数。
- `sshManager.semanticHighlight`：对没有 ANSI 颜色的普通 SSH 输出启用前端语义高亮。
- `sshManager.keepAliveInterval`：SSH keep-alive 间隔秒数，`0` 表示关闭。

## 开发

```powershell
npm install
npm run typecheck
npm test
npm run package:base
npm run package:mcp
```
