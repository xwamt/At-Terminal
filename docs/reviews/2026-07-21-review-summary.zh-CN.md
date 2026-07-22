# AT Terminal 审阅执行摘要

> 完整技术审阅见：[2026-07-21-full-code-review.md](./2026-07-21-full-code-review.md)
>
> 审阅日期：2026-07-21 · 版本：0.2.16 · 分支：main

## 一句话结论

架构健康、测试扎实、产品定位清楚；**发布前必须先修 MCP 写授权旁路与 SFTP 主机密钥校验缺口**，否则文档中的安全承诺与实现不一致。

## 必须优先处理（P0）

1. **致命：SFTP Agent 写授权被旁路**
   - 位置：`src/extension.ts` 中 `new SftpWriteAuthorizer(async () => true)`
   - 影响：文档写的「每台服务器首次 SFTP 写需确认」在 MCP 运行时实际上不会弹
   - 修复：使用默认 `new SftpWriteAuthorizer()`，并加回归测试

2. **重要：SFTP 连接未做主机密钥校验**
   - 位置：`src/sftp/SftpSession.ts` 调用 `buildSshConnectionHandle` 未传 verifier
   - 影响：界面 SFTP / Agent SFTP 可能绕过终端路径上的主机密钥保护
   - 修复：所有出站 SSH（shell / exec / sftp）统一注入 verifier

3. **重要：MCP Bridge 多窗口发现与入参校验**
   - 单文件 `~/.at-terminal/mcp-bridge.json` 后写覆盖先写
   - Bridge `parseBody` 无 schema / 无 body 大小限制
   - 修复：多 bridge 注册表 + Zod 校验 + body 上限 + 文件权限

## 代码质量总评

| 轴 | 评级 | 说明 |
| --- | --- | --- |
| 正确性 | 中高 | 核心域逻辑扎实，装配层有安全回归空洞 |
| 可读性 | 高 | 域目录清晰；`extension.ts` 过厚 |
| 架构 | 高 | 双变体 + Agent 统一服务面设计正确 |
| 安全 | 中 | 设计对，装配有洞；bridge 可继续硬化 |
| 性能 | 中 | 每次远程命令新建连接；大目录 / 终端 IPC 可优化 |
| 测试 | 高 | 覆盖广，但未锁住 authorizer 装配 |

## 功能增强建议（浓缩）

### 马上做完安全后
- 公开 `idleDisconnectMinutes` 配置
- MCP server 版本号与扩展版本对齐
- lrzsz：做真传输或改文档为「仅检测」

### 下一阶段体验
- 导入 `~/.ssh/config`
- 私钥 passphrase
- Servers 树连接状态与错误原因
- 传输队列 / 取消 / 重试面板

### Agent 方向
- 只读模式 / 每服务器命令 allowlist
- `sftp_delete` / `sftp_rename`（强确认）
- 远程只读采集类工具（主机信息、限流 tail / grep）
- 工具契约单一来源生成（package / server / docs）
- Agent 操作审计时间线

### 中长期
- 端口转发
- 多跳 ProxyJump
- 连接池复用降低 Agent 冷启动
- Marketplace 发布与签名流水线

## 已生成文档

| 文档 | 用途 |
| --- | --- |
| [2026-07-21-full-code-review.md](./2026-07-21-full-code-review.md) | 完整五轴审阅 + 排期 |
| [../decisions/ADR-001-dual-build-variants.md](../decisions/ADR-001-dual-build-variants.md) | 双构建变体决策 |
| [../decisions/ADR-002-mcp-bridge.md](../decisions/ADR-002-mcp-bridge.md) | MCP Bridge 架构决策 |
| [../decisions/ADR-003-agent-command-confirmation.md](../decisions/ADR-003-agent-command-confirmation.md) | Agent 命令确认策略 |
| [2026-07-21-feature-roadmap.md](./2026-07-21-feature-roadmap.md) | 功能路线图 |

## 建议的 0.2.17 范围

只做安全热修，不掺大功能：

1. 修复写授权旁路
2. SFTP / Agent 全路径主机密钥校验
3. Bridge 校验与 body 限制
4. 版本号对齐 + 回归测试
5. 可选：`idleDisconnectMinutes` 配置声明