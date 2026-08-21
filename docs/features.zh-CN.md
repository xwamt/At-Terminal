# 功能介绍

AT Terminal MCP 将 AT Terminal 基础版的 SSH/SFTP 工作区能力与通过共享 **AT Series** MCP hub 暴露的 Agent 工具结合在一起。

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

AT Terminal MCP 通过共享 **AT Series** hub（`~/.at-series/mcp/hub.js`）发布工具。hub 会连接回正在运行的 AT Terminal MCP 扩展 bridge，因此凭据和主机信任仍保留在扩展宿主内。

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `list_ssh_servers` | 只读 | 列出已允许后台连接的 SSH 服务器，不暴露密码或私钥。 |
| `get_terminal_context` | 只读 | 返回当前聚焦、默认连接、已连接和已知的 AT Terminal SSH 终端上下文。 |
| `run_remote_command` | 命令 | 执行经过确认的非交互 SSH 命令，并返回 stdout、stderr、exit code、timeout、duration 和截断信息。除非服务器已被信任且命令未命中「会改变状态」的黑名单，否则每条命令都要确认。stdout/stderr 各默认 64000 字节（硬顶 256000）。 |
| `sftp_list_directory` | 只读 | 通过已连接的 AT Terminal SFTP 会话列出远程目录。最多返回 `maxEntries` 条（默认 500，硬顶 5000），并带 `truncated`/`total`。 |
| `sftp_stat_path` | 只读 | 返回远程文件或目录的元信息。 |
| `sftp_read_file` | 只读 | 读取有限大小的 UTF-8 远程文本文件；默认 `maxBytes` 65536（硬顶 262144）；疑似二进制内容会被拒绝。 |
| `sftp_write_file` | 写入 | 向远程文件写入 UTF-8 文本；覆盖已有文件需要 `overwrite: true`。 |
| `sftp_create_file` | 写入 | 创建远程文件，可选写入 UTF-8 内容。 |
| `sftp_create_directory` | 写入 | 创建远程目录。 |

## 安全行为

- `run_remote_command` 确认跟随服务器信任下拉（`Trust agent remote commands`）。**不信任**每条都弹窗。**有限信任**让**未命中黑名单**的命令免确认；黑名单收录 441 个会改变状态的命令名，分 19 组（文件写入、权限、归档、磁盘、进程与服务控制、解释器与执行包装、包管理、网络传输与配置、账号、容器、编辑器与分页器、追踪调试、数据库客户端、引导）。命令按 `|`、`;`、`&&`、`||`、`&` 分段，**每一段的命令名都要过黑名单**，任一段命中即弹窗：`ps aux | grep java | head -20` 免确认，`ls && rm -rf /` 弹窗。`systemctl`、`journalctl`、`ip`、`ss`、`find`、`dmesg`、`crontab`、`date`、`hostname`、`sysctl`、`git`、`ifconfig`、`route`、`ethtool`、`sort` 按参数判断，因此 `systemctl status nginx`、`git log` 免确认，`systemctl restart nginx`、`git checkout .` 弹窗。命令替换、重定向、反斜杠转义、命令名带引号或写成路径、多行脚本在有限信任下一律弹窗。**代价写在明面上：黑名单没点名的命令，在有限信任服务器上不弹窗直接执行。** **完全信任**远程命令与 SFTP 写入都不弹窗。
- 有限信任不会跳过 SFTP 写入授权。完全信任会跳过远程命令确认和 SFTP 写入确认（含敏感路径）。任何信任档都不会跳过 SSH 主机指纹信任。
- Bridge 发布到 AT Series 注册表 `~/.at-series/bridges/<hostApp>/`。
- SFTP 写入按「目录」授权：弹窗提供 `Allow Once`（默认）、`Allow This Folder For 15 Minutes`、`Allow This Folder For The Session` 三档，任何一档都只覆盖用户当时看到的那个目录，不会覆盖整台服务器。
- 写入目标越出 SFTP 会话初始工作目录时，弹窗会明确高亮，并且不提供「本会话」这一档。
- 敏感路径（`~/.ssh`、`/etc`、`/usr`、`/root`、`*.service`、`authorized_keys`、`sudoers*`、`crontab`）一律二次确认，且永不记忆。
- Agent 的 SFTP 会话不做提权：权限不足即失败，`sudo -n` 回退只存在于用户手动操作的 SFTP 视图。
- 只读工具不会返回密码、私钥或 SecretStorage 内容。
- SFTP 读取有大小限制，避免把大文件直接灌入 Agent 上下文。
- 写入工具会解析远程路径，不允许修改远程根路径。

## 资产导入导出

运行 `AT Terminal: Export Assets` 可创建加密的 `.at-terminal-assets` 包，包含 SSH 服务器配置。密码和私钥文件是可选导出项，只有勾选后才会包含。

在另一台支持的 IDE 或设备上运行 `AT Terminal: Import Assets` 可解密并导入所选资产。导入的私钥会存放到扩展的全局存储区，服务器配置会更新为新的本地路径。SSH 主机信任记录不会迁移，因此导入后首次连接仍会请求主机信任确认。

## UI 与主题适配

- 用于添加和编辑服务器的 Webview 表单。
- 清晰的密码与私钥认证分区。
- 通过文件选择器选择私钥。
- 内联校验与保存状态。
- 图标、侧边栏和表单会适配当前 IDE 主题。
