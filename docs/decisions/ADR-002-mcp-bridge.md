# ADR-002：MCP stdio 进程 + 本机 Bridge

## 状态
已接受（多实例发现已实现）

## 日期
2026-07-21

## 背景
Agent 工具需要访问：

- 基于 SecretStorage 的凭证
- 主机密钥信任 UI
- 命令 / SFTP 写确认对话框
- 实时的 `TerminalContextRegistry` 状态

纯 stdio MCP 服务进程无法安全地直接拥有这些 VS Code API。凭证必须留在扩展宿主内。

## 决策
MCP 采用双进程模型：

1. **扩展宿主** 在 `127.0.0.1` 启动 `BridgeServer`，使用随机端口与随机 token，并写入发现元数据。
2. **`dist/mcp-server.js`**（stdio）通过 `BridgeClient` 携带 token 调用 bridge HTTP 接口。
3. Bridge 处理器把请求委托给扩展宿主内的 `AgentToolService`。

当前发现文件：`~/.at-terminal/mcp-bridge.json`，内容为 `{ port, token, pid, updatedAt }`。

## 备选方案

### 仅实现为 VS Code Language Model Tools
- 优点：无需 bridge
- 缺点：非 VS Code 的 MCP 客户端（Continue stdio、Codex、Claude Code 等）无法接入
- 结论：不能作为唯一方案

### 把凭证放进 MCP 进程
- 优点：IPC 更简单
- 缺点：扩大密钥爆炸半径；难以弹出模态确认
- 结论：否决

### 仅使用命名管道 / UDS
- 优点：不走 TCP
- 缺点：Windows / macOS / Linux 一致性与客户端支持成本高
- 结论：暂缓；回环 TCP + token 可作为可接受的 MVP

## 后果
- 安全性依赖回环绑定、token 保密与发现文件保护。
- 多窗口 IDE 可能覆盖单一发现文件（已知风险）。
- Bridge 必须校验每次请求的鉴权；工具安全仍依赖扩展 UI 确认。

## 必须修订
将单文件发现替换为多 bridge 注册表（数组或记录目录）、健康检查，并优先选择报告非空已连接终端的 bridge。在操作系统允许时强制收紧文件权限。

## 安全不变量
- 工具永远不返回密码或私钥。
- `run_remote_command` 确认规则保留在 `AgentToolService`。
- SFTP 写入必须经过 `SftpWriteAuthorizer`（生产装配不得 stub 为恒 true）。
- 所有出站 SSH 路径必须做主机密钥校验。
## 实现备注（0.2.17）

- 每扩展宿主写入 `~/.at-terminal/mcp-bridges/<id>.json`。
- 同时更新 legacy `~/.at-terminal/mcp-bridge.json` 作为最后写入快照。
- `BridgeClient` 列举候选、健康检查，并优先选择 `connectedTerminals` 非空的 bridge。
- Bridge 请求使用 Zod 校验，HTTP body 上限 2 MiB。