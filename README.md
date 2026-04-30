# AT Terminal

[中文](#中文) | [English](#english)

![AT Terminal icon](media/at-terminal-icon.png)

## 中文

AT Terminal 是一个适用于 VS Code 扩展体系的 SSH 终端与 SFTP 工作区插件。它可以在 VS Code、Cursor、Kiro、Qcode 等兼容 VS Code 插件的 IDE 中使用，不需要在远程服务器安装 VS Code Server、远程 Agent 或额外服务。

它的核心价值不是只打开一个 SSH 终端，而是把远程文件拉到本地编辑器中编辑、保存并自动同步回服务器。这样你可以让 Copilot、Kiro、Cursor、Qcode 等智能代理 IDE 直接参与远程脚本的创建、修改、解释和调试，同时保留普通 VS Code 编辑器体验。

![Kiro remote file editing demo](docs/images/%E6%96%87%E4%BB%B6%E7%BC%96%E8%BE%91%E6%93%8D%E4%BD%9Ckiro.gif)

### 为什么适合 AI IDE

- 远程文件以普通本地编辑器文档打开，AI 代理可以像处理本地项目文件一样读取、修改和重构脚本。
- 保存本地编辑器文档后，AT Terminal 会把最新内容上传回原始远程路径。
- 适合用 Copilot、Kiro、Cursor、Qcode 等工具实时新建、修改、解释和调试 Shell、Python、Node.js、配置文件和运维脚本。
- SSH 终端和 SFTP 文件视图在同一个 IDE 内协同工作，不需要在终端、SFTP 客户端和编辑器之间反复切换。
- 不依赖远程 Agent，适合临时服务器、内网机器、生产维护环境和权限受限环境。

### 功能概览

#### 远程文件本地编辑

从 `SFTP Files` 视图选择远程文件并执行 `SFTP: Edit`，文件会下载到受管理的本地编辑会话中。你可以使用 IDE 的语言高亮、搜索、补全、格式化、AI 代理和调试辅助；保存后内容会同步回服务器。

编辑流程包含：

- 按远程文件名自动选择语言模式。
- 通过普通编辑器保存触发上传。
- 协调连续快速保存，确保最新内容同步。
- 通过 VS Code 通知显示下载、上传或保存错误。
- 编辑会话由插件管理，不需要手动维护临时文件路径。

#### SSH 服务器和终端

- 在专用 Activity Bar 视图中管理 SSH 服务器。
- 添加、编辑、删除、刷新和复制服务器连接信息。
- 支持密码和私钥认证。
- 通过文件选择器选择私钥路径。
- 每次连接打开独立终端标签页。
- 从服务器列表或终端视图断开、重连会话。
- 首次连接未知主机时确认指纹，主机密钥变化时阻止连接。
- 支持终端字体、字号、滚动缓冲、语义高亮和 keep-alive 设置。

#### SFTP 文件管理

`SFTP Files` 会跟随当前活动 SSH 终端。连接成功后，它会加载远程登录目录，并允许你在 IDE 侧边栏中管理远程文件。

支持操作：

- 浏览远程目录。
- 刷新当前目录。
- 返回上级目录或跳转到输入的远程路径。
- 上传文件。
- 从 VS Code Explorer 拖拽文件到 `SFTP Files` 上传。
- 下载远程文件或文件夹。
- 新建文件和文件夹。
- 重命名文件和文件夹。
- 删除文件和文件夹。
- 复制远程路径。
- 预览远程文件。
- 从远程目录向当前 SSH 终端发送 `cd` 命令。

#### UI 和主题适配

- 添加/编辑服务器使用现代 Webview 表单，同时保持 VS Code 原生观感。
- 密码和私钥认证以清晰的模式卡片展示。
- 保存前展示连接摘要。
- 输入错误显示在对应字段附近。
- 保存按钮包含加载和禁用状态。
- 编辑服务器时，密码字段留空会保留已有密码。
- 图标、侧边栏项目、提示和表单颜色会适配当前 VS Code 主题。

#### lrzsz 检测

当远程主机安装了 `lrzsz` 时，终端输出中的 `rz` 或 `sz <file>` 会被保守检测。插件会识别支持的 ZMODEM 传输序列并启动本地适配边界。完整传输能力取决于扩展主机可用的兼容协议路径。

### 截图

#### 新增服务器

![Add server form](docs/images/%E6%96%B0%E5%A2%9E%E6%9C%8D%E5%8A%A1%E5%99%A8.png)

#### 终端主题适配

![Terminal light theme](docs/images/%E7%BB%88%E7%AB%AF%E6%A0%B7%E4%BE%8B-%E6%B5%85%E8%89%B2%E4%B8%BB%E9%A2%98.png)

![Terminal dark theme](docs/images/%E7%BB%88%E7%AB%AF%E6%A0%B7%E4%BE%8B-%E6%B7%B1%E8%89%B2%E4%B8%BB%E9%A2%98.png)

![Terminal third-party theme](docs/images/%E7%BB%88%E7%AB%AF%E6%A0%B7%E4%BE%8B-%E7%AC%AC%E4%B8%89%E6%96%B9%E4%B8%BB%E9%A2%98.png)

### 基本使用

1. 在 VS Code、Kiro、Cursor、Qcode 等兼容 IDE 中打开 AT Terminal Activity Bar 视图。
2. 点击 `SSH: Add Server`。
3. 输入主机、端口、用户名和认证信息。
4. 保存服务器。
5. 从 `Servers` 视图连接服务器，打开独立 SSH 终端。
6. 使用 `SFTP Files` 浏览、上传、下载、编辑和管理远程文件。
7. 对远程文件执行 `SFTP: Edit`，在本地编辑器中让 AI 代理协助修改脚本，保存后同步回服务器。

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

- `sshManager.terminalFontSize`: 终端字号。
- `sshManager.terminalFontFamily`: 终端字体。
- `sshManager.scrollback`: 终端滚动缓冲行数。
- `sshManager.semanticHighlight`: 为未包含 ANSI 颜色的普通 SSH 输出启用前端语义高亮。
- `sshManager.keepAliveInterval`: SSH keep-alive 间隔，单位为秒。设置为 `0` 可禁用。

### 开发

安装依赖：

```powershell
npm install
```

构建和测试：

```powershell
npm run typecheck
npm run build
npm test
```

打包 VSIX：

```powershell
npm run build
npx @vscode/vsce package --no-dependencies
```

该命令会在项目根目录生成 `at-terminal-<version>.vsix`。在 VS Code 中使用 `Extensions: Install from VSIX...` 安装，或通过命令行安装：

```powershell
code --install-extension .\at-terminal-<version>.vsix
```

### 手动验证清单

可以使用本地 SSH 服务或一次性容器验证：

- 密码登录。
- 私钥登录。
- 终端输入和输出。
- 终端窗口 resize。
- 断开和重连。
- 未知主机指纹确认。
- 主机密钥变化阻止连接。
- SFTP 目录浏览。
- SFTP 上传和下载。
- 从 VS Code Explorer 拖拽上传。
- SFTP 远程文件编辑和保存同步。
- SFTP 重命名、删除、新建文件、新建文件夹。
- 浅色、深色和第三方 VS Code 主题适配。
- lrzsz `rz` 和 `sz` 检测。

## English

AT Terminal is an SSH terminal and SFTP workspace extension for the VS Code extension ecosystem. It works in VS Code and VS Code-compatible IDEs such as Cursor, Kiro, Qcode, and similar products. It connects directly over SSH and does not require VS Code Server, a remote agent, or any server-side installation.

The main value is local editing for remote files. AT Terminal downloads a remote file into a managed local editor session, lets you edit it with the normal IDE experience, and uploads the saved content back to the original remote path. This makes it practical to use Copilot and AI-agent IDEs such as Kiro, Cursor, and Qcode to create, modify, explain, and debug scripts that live on remote machines.

### Why It Works Well With AI IDEs

- Remote files open as normal local editor documents, so AI agents can read, edit, refactor, and explain them like local project files.
- Saving the editor document uploads the latest content back to the remote server.
- Useful for Shell, Python, Node.js, configuration, and maintenance scripts.
- SSH terminal and SFTP file management stay inside the same IDE.
- No remote agent is required, which helps with temporary servers, internal hosts, production maintenance, and restricted environments.

### Features

#### Agent Tools

AT Terminal contributes VS Code language model tools and a local MCP server for compatible agents.

- `list_ssh_servers` lists configured server ids and connection metadata without exposing credentials.
- `get_terminal_context` returns `focusedTerminal`, `defaultConnectedTerminal`, `connectedTerminals`, and `knownTerminals`.
- `run_remote_command` runs a bounded command through SSH and returns stdout, stderr, exit code, timeout, duration, and truncation metadata.
- `sftp_list_directory`, `sftp_stat_path`, and `sftp_read_file` inspect remote files through the connected AT Terminal SFTP session.
- `sftp_write_file`, `sftp_create_file`, and `sftp_create_directory` write remote UTF-8 text or create remote paths after first-write authorization for that server.

Every remote command asks for confirmation before execution. SFTP write tools ask for confirmation the first time a server is written to during the current extension host session. Use `terminalId` or `serverId` to target a specific connected terminal, or omit both to use `defaultConnectedTerminal`.

#### AT Terminal MCP

AT Terminal also ships a local MCP stdio server for MCP-capable IDEs such as Continue, Cursor, and Kiro. The MCP server does not read AT Terminal credentials directly. It connects to a localhost bridge started by the AT Terminal VS Code extension, so existing server configuration, VS Code SecretStorage credentials, host key verification, and command confirmation remain in one place.

Build the MCP server:

```powershell
npm run build
```

Continue workspace example:

```yaml
name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - C:\Users\alan\Desktop\ssh-plugins\.worktrees\codex-agent-remote-command-tools\dist\mcp-server.js
```

Run `AT Terminal: Install MCP Config` from the Command Palette to create `.continue/mcpServers/at-terminal.yaml` in the current workspace.

For local development, point the MCP config at the unpacked `dist/mcp-server.js` path above. For installed VSIX testing, point it at the installed extension directory under `%USERPROFILE%\.vscode\extensions\local.at-terminal-mcp-0.2.9\dist\mcp-server.js`. Keep VS Code with AT Terminal running so the MCP bridge discovery file is available, then use Continue Agent mode and ask for `list_ssh_servers`, `get_terminal_context`, `run_remote_command`, or `sftp_read_file`.

#### Local Editing For Remote Files

Use `SFTP: Edit` from the `SFTP Files` view to open a remote file in the editor. AT Terminal downloads the file into a managed local edit session, detects the language from the file name, and uploads changes when you save.

The edit flow supports:

- Language detection based on file names.
- Normal editor save to upload.
- Coordinated rapid saves so the newest content wins.
- VS Code notifications for download, upload, and save errors.
- Managed local edit sessions without manually tracking temporary files.

#### SSH Servers And Terminals

- Manage SSH servers from the dedicated AT Terminal activity bar view.
- Add, edit, delete, refresh, and copy server connection information.
- Connect with password or private key authentication.
- Choose a private key through a file picker.
- Keep each SSH connection in its own terminal tab.
- Disconnect and reconnect sessions from the server list or terminal view.
- Validate unknown host fingerprints before trusting a server, and block changed host keys.
- Configure terminal font size, font family, scrollback, semantic highlighting, and keep-alive interval.

#### SFTP File Management

The `SFTP Files` view follows the active SSH terminal. After a terminal connects, the SFTP sidebar loads the remote login directory and lets you manage files without leaving the IDE.

Supported actions:

- Browse remote directories.
- Refresh the current directory.
- Go to a parent directory or jump to a typed remote path.
- Upload files to a remote directory.
- Drag files from VS Code Explorer into `SFTP Files` to upload them.
- Download remote files or folders.
- Create new files and folders.
- Rename files and folders.
- Delete files and folders.
- Copy remote paths.
- Preview remote files.
- Send `cd` commands from a remote directory to the active SSH terminal.

#### UI And Theme Adaptation

- Modern Webview form for adding and editing servers.
- Clear password/private-key authentication mode cards.
- Private-key selection through the system file picker.
- Connection summary before saving.
- Inline validation close to each field.
- Loading and disabled states while saving.
- Existing passwords are preserved when editing a server and leaving the password field blank.
- Icons, sidebar items, tooltips, and form colors adapt to the active VS Code theme.

#### lrzsz Detection

When the remote host has `lrzsz` installed, terminal output from `rz` or `sz <file>` is detected conservatively. The extension recognizes supported ZMODEM transfer sequences and starts the local adapter boundary. Full transfer support depends on the compatible protocol path available in the extension host.

### Basic Usage

1. Open the AT Terminal activity bar view in VS Code, Kiro, Cursor, Qcode, or another compatible IDE.
2. Click `SSH: Add Server`.
3. Enter the host, port, username, and authentication settings.
4. Save the server.
5. Connect from the `Servers` view to open an SSH terminal tab.
6. Use `SFTP Files` to browse, upload, download, edit, or manage remote files.
7. Use `SFTP: Edit` to open a remote script locally, let your AI agent help modify it, and save to sync it back.

### Commands

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

### Settings

- `sshManager.terminalFontSize`: terminal font size.
- `sshManager.terminalFontFamily`: terminal font family.
- `sshManager.scrollback`: terminal scrollback line count.
- `sshManager.semanticHighlight`: enable frontend semantic highlighting for plain SSH output that does not already contain ANSI colors.
- `sshManager.keepAliveInterval`: SSH keep-alive interval in seconds. Use `0` to disable keep-alive.

### Development

Install dependencies:

```powershell
npm install
```

Build and test:

```powershell
npm run typecheck
npm run build
npm test
```

Package a VSIX file for installation:

```powershell
npm run build
npx @vscode/vsce package --no-dependencies
```

The command generates `at-terminal-<version>.vsix` in the project root. Install it from VS Code with `Extensions: Install from VSIX...`, or from the command line:

```powershell
code --install-extension .\at-terminal-<version>.vsix
```

### Manual Verification Checklist

Use any local SSH server or a disposable container to verify:

- Password login.
- Private key login.
- Terminal input and output.
- Window resize.
- Disconnect and reconnect.
- Unknown host trust prompt.
- Changed host key blocking.
- SFTP directory browsing.
- SFTP upload and download.
- SFTP drag upload from VS Code Explorer.
- SFTP remote file edit and save synchronization.
- SFTP rename, delete, new file, and new folder actions.
- Theme adaptation in light, dark, and third-party VS Code themes.
- lrzsz `rz` and `sz` detection.
