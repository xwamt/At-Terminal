# AT Terminal 完整代码审阅与优化路线图

- **日期**: 2026-07-21
- **范围**: 工作树 `main` @ `c77869a`，版本 `0.2.16`
- **审阅方法**: 五轴代码审阅（正确性 / 可读性 / 架构 / 安全 / 性能）+ 安全加固清单 + 文档 / ADR 视角
- **结论摘要**: 产品定位清晰、测试密度高、Agent 安全模型设计正确，但存在 **装配层安全旁路** 与 **主机密钥校验覆盖不全** 等应优先修复项。功能上建议补齐连接管理、多窗口 MCP、SFTP 写工具面和可观测性。

---

## 1. 项目画像

| 维度 | 现状 |
| --- | --- |
| 产品 | 无代理 SSH 终端 + SFTP 工作区；MCP 变体叠加 Agent 工具 |
| 技术栈 | TypeScript、VS Code Extension API、ssh2、xterm、Zod、Vitest、esbuild、MCP SDK |
| 源码 | `src/` 约 50 个文件；`webview/` 终端与表单；`test/` 约 58 个文件 |
| 变体 | `package:base` / `package:mcp`，编译期开关 `__AT_TERMINAL_MCP_ENABLED__` |
| 入口 | `src/extension.ts` 装配根；`src/mcp/server.ts` 独立 stdio MCP 进程 |

### 1.1 分层心智模型

```text
界面层: ServerTree / SftpTree / TerminalPanel / ServerFormPanel
  -> extension.ts（装配与命令注册）
    -> ConfigManager / HostKeyStore / TerminalContextRegistry
    -> SshSession / SftpManager+SftpSession / SftpEditSessionManager
    -> （仅 MCP）AgentToolService + BridgeServer
         ^ stdio mcp-server.js 通过 BridgeClient + 发现文件回连
```

---

## 2. 五轴审阅结论

### 2.1 正确性

**做得好的地方**

- 服务器配置使用 Zod 严格 schema；资产包 envelope / payload 同样校验。
- 远程命令有超时、输出上限与截断元数据，避免 Agent 上下文被刷爆。
- SFTP Agent 读文件有字节上限、二进制拒绝、根路径写保护。
- 远程编辑有基于 mtime / size 的冲突检测，以及关闭前冲刷上传。
- 跳板机删除前有引用阻断；删除服务器会 `HostKeyStore.forget`。

**问题**

| 严重度 | 发现 | 证据 | 建议 |
| --- | --- | --- | --- |
| **致命** | MCP 装配时 SFTP 写授权被旁路：`new SftpWriteAuthorizer(async () => true)`，文档承诺的「每服务器首次写授权」在运行时不生效 | `src/extension.ts` MCP 分支 | 改为默认构造 `new SftpWriteAuthorizer()`，并加集成测试断言会调用确认 |
| **重要** | `SftpSession` 建立连接未传入 `HostKeyVerifier`；界面 SFTP / Agent SFTP 可能跳过主机密钥校验 | `src/sftp/SftpSession.ts` | 与终端一致注入校验器；Agent 新建连接同样强制校验 |
| **重要** | Bridge 的 `parseBody` 无 schema 校验，畸形 body 可能 500 或静默宽松解析 | `src/mcp/BridgeServer.ts` | 与 MCP server 侧 Zod schema 对齐 |
| **重要** | 多窗口 / 多扩展宿主共享单一 `~/.at-terminal/mcp-bridge.json`，后启动覆盖先启动，MCP 客户端可能连到错误窗口 | `BridgeDiscovery.ts` | 改为多 bridge 注册表（数组或目录）+ 健康探测 + 优先 `connectedTerminals` 非空 |
| **建议** | `src/mcp/server.ts` 硬编码 `version: '2.10.2'`，与扩展 `0.2.16` 不一致 | `server.ts` | 与 package 版本同源 |
| **建议** | `idleDisconnectMinutes` 代码默认 60 分钟，但 `package*.json` configuration 未声明，用户设置界面不可见 | `TerminalPanel.ts` | 补配置项与文档 |
| **建议** | `lrzsz` 仅检测序列并 toast，无真实传输适配 | `LrzszTransfer.ts` | 要么完成实现，要么在功能文档标注「仅检测」 |

### 2.2 可读性与简洁性

**优点**

- 目录按域划分（ssh / sftp / agent / mcp / assets / webview），命名一致。
- 测试与源文件基本镜像，偏行为测试。
- 工具类（`commandPreview`、`redaction`、`RemotePath`）边界清楚。

**问题**

| 严重度 | 发现 | 建议 |
| --- | --- | --- |
| **重要** | `extension.ts` 约 18KB，命令注册、SFTP 界面流程、MCP 启动全堆在 `activate` | 拆为 `registerServerCommands` / `registerSftpCommands` / `activateMcpSurface` |
| **小优化** | 部分 webview / server-form 大文件内联 HTML 字符串 | 可逐步迁到模板或分段 builder，非阻塞 |
| **小优化** | 部分中文文档在部分终端下出现乱码 | 统一 UTF-8；CI 增加中文抽样校验 |

### 2.3 架构

**优点**

- 双变体：同一业务代码 + 编译开关 + 两套 manifest，成本可控。
- Agent 工具统一经 `AgentToolService`，Language Model Tools 与 MCP bridge 共用，避免双实现漂移。
- 凭证留在扩展宿主：MCP 子进程只持 bridge token，不直接读 SecretStorage。
- 终端上下文注册表把「焦点终端 / 默认已连接终端」变成可查询状态，是 SFTP 与 Agent 的正确枢纽。

**问题与演进**

| 严重度 | 发现 | 建议 |
| --- | --- | --- |
| **可考虑** | Agent SFTP 会再开独立 `SftpSession`，与界面 `SftpManager` 会话不共享 | 短期可接受；中期可共享连接池降低握手成本 |
| **可考虑** | 跳板机仅一层（`jumpHostId` 被强制清空），无多跳 | 文档明确「单跳」；需要时再做链路 |
| **可考虑** | 无显式连接池 / 会话复用策略文档 | 写 ADR：何时复用 shell、何时独立 exec、SFTP 生命周期 |
| **备忘** | `RemoteCommandExecutor` 每次 exec 新建 SSH 连接，正确但偏慢 | 高频 Agent 场景可考虑短连接复用（复杂，需设计） |

### 2.4 安全（重点）

| 控制项 | 状态 | 说明 |
| --- | --- | --- |
| 密码 SecretStorage | 通过 | 不进 globalState 明文 |
| 主机密钥信任 | 部分 | 终端 / 测试连接有；**SFTP 路径缺失** |
| Agent 命令确认 | 通过 | 自动批准不覆盖破坏性启发式 |
| SFTP 写授权 | **失败** | 装配旁路 `async () => true` |
| Bridge 绑定 127.0.0.1 + token | 通过但可加强 | token 落盘明文；文件权限未强制；无 body 大小限制 |
| Webview CSP | 通过 | nonce + `default-src 'none'` |
| 输出脱敏 | 部分 | 有私钥 / 密码模式；覆盖有限 |
| 资产导出加密 | 通过 | scrypt + AES-256-GCM |
| 依赖审计 | 本次未执行 | 发布前应 `npm audit` |

**额外安全建议**

1. **立即修复** SFTP 写授权旁路（致命）。
2. **统一主机密钥校验**到所有出站 SSH（终端、SFTP、exec、tester）。
3. Bridge 发现文件：Windows ACL / Unix `0600`；考虑 token 轮换与 `updatedAt` 过期。
4. Bridge 请求：最大 body 限制（例如 1–2MB）、schema 校验、可选速率限制。
5. `agentCommandAutoApprove` 破坏性检测可扩充（`curl|sh`、`chmod 777`、写 `authorized_keys`、`iptables -F` 等），并支持用户可配置拒绝列表。
6. Agent 工具增加 **只读模式 / 全局急停开关** 配置。
7. 审计日志：记录谁在何时对哪台服务器执行了命令 / 写文件（本地环缓冲，可选导出）。

### 2.5 性能

| 点 | 评估 | 建议 |
| --- | --- | --- |
| 每次 `run_remote_command` 新建 SSH | 正确但冷启动慢（尤其跳板） | 会话复用 / 保活连接池（P1 功能） |
| SFTP 列表无分页 | 超大目录可能卡界面 | 目录条目上限 + 虚拟列表 / 分页 |
| 终端输出 `payload: [...data]` 展开字节数组 | 高吞吐时 IPC 开销大 | 考虑 base64 分块或压缩策略评估 |
| Bridge 无并发限制 | Agent 并行工具可能打满连接 | 每服务器 inflight 队列 |
| 资产加解密 | scrypt 合理 | 保持；文档提示大私钥包耗时 |

---

## 3. 测试与验证观察

**优点**

- 几乎每个核心模块有对应测试；package 变体、MCP 安装、docs / skills 也有契约测试。
- 远程编辑、传输 reporter、bridge 重试有较新的回归覆盖（0.2.16）。

**缺口**

1. **没有测试锁定 extension 装配使用真实 `SftpWriteAuthorizer` 默认确认** —— 当前致命问题未被拦住。
2. 缺少「所有连接路径都带 host verifier」的架构测试。
3. 多 bridge / 多窗口 discovery 缺少端到端场景。
4. 跳板机 + agent exec + SFTP 组合路径覆盖可加强。
5. 发布清单可固化：`typecheck` + `test` + `package:base` + `package:mcp` + `npm audit`。

---

## 4. 功能层优化建议（按优先级）

### P0 — 安全与信任（应尽快）

1. 修复 SFTP 写授权旁路，恢复文档描述行为。
2. SFTP / Agent 连接强制主机密钥校验。
3. Bridge 发现硬化（权限、多实例、过期清理）。
4. Bridge 入参 Zod 校验 + body 上限。

### P1 — 连接与运维体验

1. **连接状态中心**：Servers 树显示 connecting / connected / error；一键重连与失败原因。
2. **SSH 配置导入**：解析 `~/.ssh/config`（Host / HostName / User / Port / IdentityFile / ProxyJump）。
3. **私钥口令（passphrase）** 支持。
4. **空闲断开可配置**（补 package configuration + 界面文案）。
5. **命令历史 / 会话笔记**（按服务器本地保存，不含密钥）。
6. **传输队列面板**：上传下载进度、取消、失败重试。

### P2 — Agent / MCP 能力扩展

1. 新工具建议：
   - `sftp_delete` / `sftp_rename` / `sftp_download_to_workspace`（严格确认）
   - `run_remote_command_batch`（同一确认上下文内有限条）
   - `tail_remote_file` / `grep_remote`（只读、限流）
   - `list_processes` / `get_host_facts`（封装安全只读采集）
2. **每服务器 Agent 策略**：allowlist 工作目录、命令前缀、只读服务器开关。
3. **多窗口 bridge 选择**：discovery 列表 + `connectedTerminals` 优先。
4. **MCP 工具与 package.json languageModelTools schema 单一来源生成**，避免三处漂移。
5. **审计与回放**：Agent 操作时间线视图。

### P3 — SFTP / 终端深化

1. 真正的 **rz/sz 传输适配**，或从功能列表降级为「检测提示 + 引导使用 SFTP」。
2. 目录递归上传 / 下载、冲突策略（跳过 / 覆盖 / 重命名）。
3. 远程权限 / 所有者显示与 chmod（谨慎）。
4. 终端搜索、分屏、回放、选择即复制策略增强。
5. 端口转发（本地 / 远程 / 动态）—— 与无代理定位契合，但复杂度高。
6. 多跳 ProxyJump 链。

### P4 — 产品化与生态

1. 设置同步友好的服务器导出（已有 assets；可加「不含密钥的轻量分享」）。
2. 官方 Marketplace 发布流水线与签名。
3. 遥测（可选、脱敏、默认关）：连接失败类型分布。
4. 中文文档编码与 README 入口统一。
5. 架构 ADR 沉淀（见第 6 节）。

---

## 5. 代码层重构建议（不改行为优先）

### 5.1 拆分 `extension.ts`

建议结构：

```text
src/activation/
  createCoreServices.ts      # 配置、主机密钥、树、SFTP、终端上下文
  registerServerCommands.ts
  registerSftpCommands.ts
  activateMcp.ts             # 工具、bridge、安装器
  hostKeyVerifier.ts
```

收益：可测装配、降低致命回归概率、PR 更易审。

### 5.2 统一出站连接工厂

```text
createOutboundSshHandle(server, { purpose: 'shell' | 'exec' | 'sftp', hostKeyVerifier })
```

所有路径强制 verifier + 统一跳板机 + 统一 keepalive。

### 5.3 工具契约单一来源

用一份 `tools.manifest.ts`（或 JSON）生成：

- `package.mcp.json` 的 languageModelTools 片段
- `mcp/server.ts` 的 registerTool
- `BridgeServer` 路由
- 文档工具表

### 5.4 可观测性

- 内部输出通道：`AT Terminal` 日志（连接、bridge、授权决策）。
- 错误码规范化：`HOST_KEY_CHANGED` / `AUTH_FAILED` / `BRIDGE_UNAVAILABLE`，便于 Agent 解释。

---

## 6. 建议沉淀的 ADR

| 编号 | 主题 | 状态建议 |
| --- | --- | --- |
| ADR-001 | 双构建变体（基础版 vs MCP）与编译期开关 | 已接受（已补写） |
| ADR-002 | MCP stdio 子进程 + 本机 Bridge + 发现文件 | 已接受；需修订多实例 |
| ADR-003 | Agent 命令确认 vs 自动批准 vs 破坏性启发式 | 已接受 |
| ADR-004 | 凭证仅 SecretStorage；资产包 scrypt+GCM；主机信任不随资产迁移 | 建议补写 |
| ADR-005 | SFTP 跟随 TerminalContext，而非全局单连接 | 建议补写 |
| ADR-006 | 单层跳板机（非多跳） | 建议补写 |

---

## 7. 优先修复清单（可直接排期）

### 迭代 A（安全热修，建议 0.2.17）

1. 去掉 `SftpWriteAuthorizer(async () => true)` 旁路。
2. `SftpSession` / Agent `createSession` 注入主机密钥校验器。
3. 增加回归测试：authorizer 被调用；无 verifier 的连接工厂被禁止。
4. Bridge body 限制 + Zod 校验。
5. MCP server 版本与扩展版本对齐。

### 迭代 B（稳定性）

1. 多 bridge 注册与选择。
2. `idleDisconnectMinutes` 配置公开化。
3. 拆分 `extension.ts`。
4. 工具契约单一来源。

### 迭代 C（功能）

1. SSH config 导入 + passphrase。
2. 传输队列界面。
3. Agent 只读模式 / 策略。
4. lrzsz 真实现或文档降级。

---

## 8. 审阅检查表

### 正确性
- [x] 理解产品意图与双变体
- [x] 识别关键路径问题（授权旁路、主机密钥缺口）
- [ ] 本次未重跑全量 `npm test`（审阅基于静态源码；修复后应全量验证）

### 可读性
- [x] 模块边界总体清晰
- [x] `extension.ts` 过厚已记录

### 架构
- [x] Agent 统一服务面合理
- [x] 多窗口 bridge 架构风险已记录

### 安全
- [x] 凭证、CSP、资产加密已评估
- [x] 致命 / 重要安全项已标注

### 性能
- [x] 新建连接、大目录、终端 IPC 风险已记录

### 结论
- **不能视为「可安心发布、无安全债」状态**：在迭代 A 合并前，MCP 写路径安全声明与实现不一致。
- 产品架构健康度：**良好**；测试文化：**良好**；安全闭环：**需热修**。

---

## 9. 参考路径

- 装配根：`src/extension.ts`
- Agent 服务：`src/agent/AgentToolService.ts`
- 写授权：`src/agent/SftpWriteAuthorizer.ts`
- Bridge：`src/mcp/BridgeServer.ts`、`src/mcp/BridgeDiscovery.ts`、`src/mcp/server.ts`
- SSH：`src/ssh/SshConnectionConfig.ts`、`src/ssh/SshSession.ts`、`src/sftp/SftpSession.ts`
- 功能文档：`docs/features.md`
- 版本说明：`docs/releases/0.2.16.md`