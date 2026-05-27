# 功能介绍

AT Terminal MCP 将 AT Terminal 基础版的 SSH/SFTP 工作区能力与面向 Agent 的 MCP 和 VS Code language model tools 结合在一起。

## 基础 AT Terminal 能力

MCP 版仍然包含基础版工作流：

- SSH 服务器管理。
- 密码和私钥认证。
- 主机指纹确认和已信任主机指纹变更阻断。
- SSH 终端标签页。
- SFTP 浏览、上传、下载和拖拽上传。
- SFTP 新建、重命名、删除、复制路径和预览。
- 远程文件本地编辑，并在保存时上传同步。
- 终端字体、滚动缓冲、语义高亮和 keep-alive 设置。
- `rz`/`sz` 序列检测。

## SSH 终端

- 管理 SSH 服务器配置。
- 使用密码或私钥认证。
- 确认未知主机指纹。
- 阻止已信任主机的指纹变更。
- 每个 SSH 连接以独立终端标签页打开。
- 断开和重连会话。
- 配置终端字体、滚动缓冲、语义高亮和 keep-alive 行为。

## SFTP 文件管理

`SFTP Files` 视图会跟随当前活动 SSH 终端，连接后自动加载远程登录目录。

支持的操作：

- 浏览远程目录。
- 刷新当前目录。
- 跳转到父目录或输入远程路径。
- 上传文件。
- 从 VS Code Explorer 拖拽文件到 SFTP 视图上传。
- 下载远程文件或目录。
- 创建文件和目录。
- 重命名、删除和复制远程路径。
- 预览远程文件。
- 从远程目录向当前 SSH 终端发送 `cd` 命令。

## 远程文件本地编辑

使用 `SFTP: Edit` 可以把远程文件打开到本地编辑器。扩展会下载文件、识别语言、监听保存，并在保存时把内容上传回原远程路径。

这个流程适合：

- Shell 脚本。
- Python 和 Node.js 脚本。
- 配置文件。
- 运维和部署脚本。
- 需要 AI 辅助解释或重构的远程文件。

## MCP 和 Agent 工具

AT Terminal MCP 提供 VS Code language model tools 和本地 stdio MCP server。MCP server 会连接回正在运行的 AT Terminal MCP 扩展，因此凭据和主机信任仍保留在扩展宿主内。

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `list_ssh_servers` | 只读 | 列出已配置的 SSH 服务器，不暴露密码或私钥。 |
| `get_terminal_context` | 只读 | 返回当前聚焦、默认连接、已连接和已知的 AT Terminal SSH 终端上下文。 |
| `run_remote_command` | 命令 | 执行经过确认的非交互 SSH 命令，并返回 stdout、stderr、exit code、timeout、duration 和截断信息。 |
| `sftp_list_directory` | 只读 | 通过已连接的 AT Terminal SFTP 会话列出远程目录。 |
| `sftp_stat_path` | 只读 | 返回远程文件或目录的元信息。 |
| `sftp_read_file` | 只读 | 读取有限大小的 UTF-8 远程文本文件；疑似二进制内容会被拒绝。 |
| `sftp_write_file` | 写入 | 向远程文件写入 UTF-8 文本；覆盖已有文件需要 `overwrite: true`。 |
| `sftp_create_file` | 写入 | 创建远程文件，可选写入 UTF-8 内容。 |
| `sftp_create_directory` | 写入 | 创建远程目录。 |

## 安全行为

- `run_remote_command` 在目标服务器启用 `Trust agent remote commands` 前会请求确认。疑似危险命令仍会请求确认。
- 服务器信任开关只影响 `run_remote_command`，不会跳过 SFTP 写入授权或 SSH 主机指纹信任。
- SFTP 写入工具会在当前扩展宿主会话内，对每台服务器的首次写入请求确认。
- 只读工具不会返回密码、私钥或 SecretStorage 内容。
- SFTP 读取有大小限制，避免把大文件直接灌入 Agent 上下文。
- 写入工具会解析远程路径，并禁止修改远程根路径。

## 资产导入导出

运行 `AT Terminal: Export Assets` 可以创建加密的 `.at-terminal-assets` 包，用于保存 SSH 服务器配置。密码和私钥文件是可选导出项，只有在选择后才会包含。

在另一个受支持的 IDE 或设备中运行 `AT Terminal: Import Assets`，可以解密并导入选中的资产。导入的私钥会存储在扩展的全局存储区域，服务器配置会更新为新的本地路径。SSH 主机信任记录不会迁移，因此导入后的首次连接仍会请求主机信任确认。

## UI 和主题适配

- 使用 Webview 表单添加和编辑服务器。
- 密码和私钥认证区域清晰分组。
- 私钥支持通过文件选择器选择。
- 表单提供内联校验和保存状态。
- 图标、侧边栏和表单会跟随当前 IDE 主题。
