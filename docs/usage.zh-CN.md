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

- `at-terminal-*.vsix`：基础版，不包含 MCP bridge / hub。
- `at-terminal-mcp-*.vsix`：MCP 版，包含 AT Series hub 打包与 bridge。

安装 MCP 版：

```powershell
code --install-extension .\at-terminal-mcp-0.2.17.vsix
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
- 写入名为 **AT Series** 的 MCP 条目，使用 `node` 运行 `~/.at-series/mcp/hub.js`，并迁移掉旧的 per-plugin `AT Terminal` 条目。
- 默认 `autoApprove` 仅包含 hub 内置工具与 read 风险工具；`run_remote_command`（exec）以及 SFTP 写/创建类工具不会进入 autoApprove。

如果自动配置失败，手动把 IDE MCP 客户端指向共享 hub（仅 **AT Series**，不要再指向 per-plugin `mcp-server.js`）：

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

请保持安装了 AT Terminal MCP 的 IDE 窗口运行，以便扩展向 `~/.at-series` 发布 bridge 并选举 `hub.js`。

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
Use the AT Series / AT Terminal tool list_ssh_servers to list my SSH servers authorized for background connections.
Use get_terminal_context to show my AT Terminal context.
Use sftp_list_directory to list /tmp on the connected AT Terminal server.
Use sftp_read_file to read /etc/os-release on the connected AT Terminal server.
```

## Cursor

Cursor 支持：

- 项目配置：`.cursor/mcp.json`
- 全局配置：`~/.cursor/mcp.json`

示例：

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

修改后重启 Cursor 或刷新 MCP servers。保持安装了 AT Terminal MCP 的 Cursor 窗口运行，hub 才能连接本地 bridge。

## Continue

Workspace 示例：

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

仓库内也包含示例文件：

```text
docs/mcp/continue-at-terminal-mcp.yaml
```

## Agent 访问

安装 `at-terminal-mcp-*.vsix` 后，请为 IDE 配置 **AT Series** MCP（优先使用 `AT Terminal: Install MCP Config`）。`list_ssh_servers`、`get_terminal_context` 和 SFTP 工具通过共享 hub 暴露，而不是 VS Code 内置 LM 工具贡献。

示例提示词：

```text
Use list_ssh_servers to list my AT Terminal SSH servers.
Use get_terminal_context to show my AT Terminal context.
Use sftp_read_file to read /etc/os-release from the connected AT Terminal server.
```

如果工具不可用：

1. 确认安装的是 MCP 版，不是基础版。
2. Reload Window，并保持 AT Terminal MCP 已激活。
3. 运行 `AT Terminal: Install MCP Config`。
4. 确认存在 `~/.at-series/mcp/hub.js`，且 MCP 条目名称为 `AT Series`。

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
- `AT Terminal: Uninstall AT Series MCP Config`

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
