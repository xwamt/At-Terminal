# AT Terminal MCP 中文文档

AT Terminal MCP 是 AT Terminal 的 MCP 增强版。它保留基础版的 SSH 终端、SFTP 文件管理和远程文件本地编辑能力，同时增加 VS Code language model tools 和本地 stdio MCP server，方便 GitHub Copilot Chat、Kiro、Cursor、Continue 等 Agent 调用远程命令和 SFTP 工具。

如果你只需要 SSH/SFTP 功能，请安装基础版 `AT Terminal`。如果你需要让 IDE Agent 调用远程命令或远程文件工具，请安装 `AT Terminal MCP`。

## 文档入口

- [功能介绍](features.zh-CN.md)
- [使用教程](usage.zh-CN.md)
- [Continue MCP 配置示例](mcp/continue-at-terminal-mcp.yaml)
- [Agent skill 指南](../skills/at-terminal-mcp/SKILL.md)

## 工作方式

MCP server 不直接读取 AT Terminal 的密码、私钥或服务器配置。实际调用链是：

1. AT Terminal MCP 扩展在 VS Code、Kiro、Cursor 等兼容 IDE 中启动。
2. 扩展启动本地 localhost bridge，并写入发现文件。
3. MCP Client 通过 `node dist/mcp-server.js` 启动 stdio MCP server。
4. MCP server 连接回本地 bridge。
5. 扩展使用已有的 AT Terminal 配置、SecretStorage、主机指纹校验和确认弹窗执行工具调用。

因此，使用 MCP 工具前，需要保持安装了 AT Terminal MCP 的 IDE 窗口处于运行状态，并激活过扩展。

## 核心能力

- SSH 服务器管理、密码/私钥认证、主机指纹确认和变更阻断。
- SSH 终端标签页。
- SFTP 浏览、上传、下载、拖拽上传、创建、重命名、删除、复制路径和预览。
- 远程文件本地编辑，并在保存时同步回远程路径。
- GitHub Copilot Chat language model tools。
- 面向 Kiro、Cursor、Continue 等 MCP Client 的本地 stdio MCP server。
- 远程命令确认、SFTP 写入授权、只读工具不暴露密码或私钥。
- 加密资产导入导出，用于迁移 SSH 服务器配置。
