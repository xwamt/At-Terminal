# AT Terminal

[中文](#中文) | [English](#english)

![AT Terminal icon](media/at-terminal-icon.png)

## 中文

AT Terminal 是一个面向 VS Code 系列 IDE 的 SSH 终端和 SFTP 工作区插件。它直接通过 SSH 连接远程服务器，不需要安装 VS Code Server、远程 Agent 或任何服务端组件。

这个 README 属于基础版 `AT Terminal`。基础版不包含 Copilot language model tools，也不包含本地 MCP server。如果你需要 Agent/MCP 能力，请安装 `AT Terminal MCP` 版本。

### 适合 AI IDE 的远程开发流程

- 远程文件可以通过 `SFTP: Edit` 打开成本地编辑器文档。
- 保存本地编辑器文档时，插件会把最新内容同步回远程原路径。
- Copilot、Kiro、Cursor、Qcode 等 AI IDE 可以像处理本地文件一样阅读、解释和修改远程脚本。
- SSH 终端、SFTP 文件管理和远程文件编辑都在同一个 IDE 内完成。
- 不需要在生产机、临时机、内网机上安装远程服务。

### 功能

#### SSH 终端

- 管理 SSH 服务器配置。
- 支持密码和私钥认证。
- 支持未知主机指纹确认。
- 阻止已信任主机的指纹变更。
- 每个 SSH 连接以独立终端标签页打开。
- 支持断开和重连。
- 支持终端字体、滚动缓冲、语义高亮和 keep-alive 设置。

#### SFTP 文件管理

`SFTP Files` 视图会跟随当前活动 SSH 终端，连接后自动加载远程登录目录。

支持操作：

- 浏览远程目录。
- 刷新当前目录。
- 跳转到父目录或输入远程路径。
- 上传文件。
- 从 VS Code Explorer 拖拽文件到 SFTP 视图上传。
- 下载远程文件或目录。
- 新建文件和目录。
- 重命名、删除、复制远程路径。
- 预览远程文件。
- 从远程目录向当前 SSH 终端发送 `cd` 命令。

#### 远程文件本地编辑

使用 `SFTP: Edit` 可以把远程文件打开到本地编辑器。插件会下载文件、识别语言、监听保存，并在保存时上传回远程路径。

这个流程适合修改：

- Shell 脚本。
- Python/Node.js 脚本。
- 配置文件。
- 运维和部署脚本。
- 需要 AI 辅助解释或重构的远程文件。

#### UI 和主题

- 使用 Webview 表单添加和编辑服务器。
- 密码/私钥认证模式清晰分组。
- 私钥支持文件选择器。
- 表单有内联校验和保存状态。
- 图标、侧边栏和表单颜色跟随 IDE 主题。

#### lrzsz 检测

当远程主机安装了 `lrzsz`，终端输出中出现 `rz` 或 `sz <file>` 的 ZMODEM 序列时，插件会进行保守检测并启动本地适配流程。完整传输能力取决于当前扩展宿主可用的协议路径。

### 截图

![Add server form](docs/images/%E6%96%B0%E5%A2%9E%E6%9C%8D%E5%8A%A1%E5%99%A8.png)

![Terminal light theme](docs/images/%E7%BB%88%E7%AB%AF%E6%A0%B7%E4%BE%8B-%E6%B5%85%E8%89%B2%E4%B8%BB%E9%A2%98.png)

![Terminal dark theme](docs/images/%E7%BB%88%E7%AB%AF%E6%A0%B7%E4%BE%8B-%E6%B7%B1%E8%89%B2%E4%B8%BB%E9%A2%98.png)

![Terminal third-party theme](docs/images/%E7%BB%88%E7%AB%AF%E6%A0%B7%E4%BE%8B-%E7%AC%AC%E4%B8%89%E6%96%B9%E4%B8%BB%E9%A2%98.png)

### 基本使用

1. 打开 AT Terminal 活动栏视图。
2. 执行 `SSH: Add Server`。
3. 填写主机、端口、用户名和认证方式。
4. 保存服务器。
5. 从 `Servers` 视图连接服务器。
6. 使用 `SFTP Files` 浏览和管理远程文件。
7. 使用 `SFTP: Edit` 本地编辑远程文件并保存同步。

### 命令

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

### 设置

- `sshManager.terminalFontSize`: 终端字体大小。
- `sshManager.terminalFontFamily`: 终端字体。
- `sshManager.scrollback`: 终端滚动缓冲行数。
- `sshManager.semanticHighlight`: 对无 ANSI 色彩的普通 SSH 输出启用前端语义高亮。
- `sshManager.keepAliveInterval`: SSH keep-alive 间隔秒数，`0` 表示关闭。

### 开发和打包

```powershell
npm install
npm run typecheck
npm test
npm run package:base
```

生成的基础版 VSIX：

```text
at-terminal-0.2.9.vsix
```

## English

AT Terminal is an SSH terminal and SFTP workspace extension for VS Code-compatible IDEs. It connects directly over SSH and does not require VS Code Server, a remote agent, or any server-side installation.

This README belongs to the base `AT Terminal` build. The base build does not include Copilot language model tools or the local MCP server. Install `AT Terminal MCP` if you need agent and MCP integrations.

### Why It Works Well With AI IDEs

- Remote files can be opened as local editor documents through `SFTP: Edit`.
- Saving the local editor document uploads the latest content back to the original remote path.
- Copilot, Kiro, Cursor, Qcode, and similar IDEs can read, explain, and modify remote scripts like normal local files.
- SSH terminal, SFTP file management, and remote editing stay inside one IDE.
- No remote service needs to be installed on production, temporary, or internal servers.

### Features

#### SSH Terminal

- Manage SSH server configurations.
- Password and private-key authentication.
- Unknown host fingerprint confirmation.
- Changed host key blocking.
- One terminal tab per SSH connection.
- Disconnect and reconnect.
- Terminal font, scrollback, semantic highlighting, and keep-alive settings.

#### SFTP File Management

The `SFTP Files` view follows the active SSH terminal and loads the remote login directory after connection.

Supported actions:

- Browse remote directories.
- Refresh the current directory.
- Go to the parent directory or jump to a typed remote path.
- Upload files.
- Drag files from VS Code Explorer into the SFTP view.
- Download remote files or folders.
- Create files and folders.
- Rename, delete, and copy remote paths.
- Preview remote files.
- Send `cd` commands from a remote directory to the active SSH terminal.

#### Local Editing For Remote Files

Use `SFTP: Edit` to open a remote file in a local editor. The extension downloads the file, detects the language, watches saves, and uploads the saved content back to the remote path.

This works well for:

- Shell scripts.
- Python and Node.js scripts.
- Configuration files.
- Operations and deployment scripts.
- Remote files that need AI-assisted explanation or refactoring.

#### UI And Theme Adaptation

- Webview form for adding and editing servers.
- Clear password/private-key authentication sections.
- Private-key selection through the file picker.
- Inline validation and saving state.
- Icons, sidebars, and forms adapt to the active IDE theme.

#### lrzsz Detection

When the remote host has `lrzsz` installed, terminal output from `rz` or `sz <file>` is detected conservatively and starts the local adapter flow. Full transfer support depends on the compatible protocol path available in the extension host.

### Basic Usage

1. Open the AT Terminal activity bar view.
2. Run `SSH: Add Server`.
3. Enter host, port, username, and authentication settings.
4. Save the server.
5. Connect from the `Servers` view.
6. Use `SFTP Files` to browse and manage remote files.
7. Use `SFTP: Edit` to edit a remote file locally and sync on save.

### Development

```powershell
npm install
npm run typecheck
npm test
npm run package:base
```

Generated base VSIX:

```text
at-terminal-0.2.9.vsix
```
