# AT Terminal (VS Code / Cursor 扩展版) 优化建议与实施计划

> **适用范围**：`at-terminal-series` 主分支（`main`，`v0.3.5`），面向 VS Code / Cursor / Kiro 兼容 IDE 的 Base 版与 MCP 版扩展。  
> **文档定位**：本文档基于 `main` 分支源码现状编写，可直接对照逐项落地执行；每项均包含精确代码落点、问题原因、实施方案与验收标准。  
> **创建日期**：2026-11-20

---

## 一、 优化项总览表（执行顺序与优先级）

| 编号 | 优先级 | 类别 | 优化主题 | 核心涉及文件 |
| :--- | :---: | :--- | :--- | :--- |
| `OPT-01` | **P0** | 宿主稳定性 | 为全部 4 处 `ssh2.Client` 补齐常驻 `error` / `close` 监听，防止 Extension Host 崩溃与僵尸会话 | `src/ssh/SshSession.ts`, `src/ssh/SshConnectionConfig.ts`, `src/sftp/SftpSession.ts`, `src/extension.ts` |
| `OPT-02` | **P0** | 会话与资源 | 修复 `idleDisconnectMinutes` 误杀持续输出会话及终端断连未释放 Agent SFTP 连接 | `src/webview/TerminalPanel.ts`, `src/extension.ts`, `src/agent/SftpAgentService.ts` |
| `OPT-03` | **P0** | 连接池一致性 | 服务器配置修改/删除时联动驱逐 `RemoteCommandExecutor` 连接池 | `src/agent/RemoteCommandExecutor.ts`, `src/extension.ts` |
| `OPT-04` | **P1** | 安全加固 | 加固 SFTP `sudo -n` 回退写入 `/tmp` 临时文件权限（`0o600`）与覆盖安全性 | `src/sftp/SftpSession.ts` |
| `OPT-05` | **P1** | 连接性能 | 跳板机（JumpHost）连接池复用与多级链式跳板支持（含环路检测） | `src/ssh/SshConnectionConfig.ts` |
| `OPT-06` | **P1** | 连接性能 | 合并 MCP Agent 后台 SSH 连接池（命令执行与 SFTP 共享底层 `Client`） | `src/agent/RemoteCommandExecutor.ts`, `src/agent/SftpAgentService.ts` |
| `OPT-07` | **P1/P2** | MCP 链路 | 打通 `BridgeServer` HTTP 请求中断到 `AbortSignal` 的取消链路并优化解码/超时清理 | `src/mcp/BridgeServer.ts`, `src/agent/AgentToolService.ts`, `src/agent/RemoteCommandExecutor.ts` |
| `OPT-08` | **P1/P2** | Agent 能力 | 为 `SftpAgentService` 补齐读超时、`~` 家目录展开与局部编辑/本地直传能力 | `src/agent/SftpAgentService.ts`, `src/mcp/toolCatalog.ts`, `src/mcp/BridgeServer.ts` |
| `OPT-09` | **P2** | 磁盘 I/O | 优化 `AgentAuditLog` 重复 `mkdir` 调用并增加日志大小轮转 | `src/agent/AgentAuditLog.ts` |
| `OPT-10` | **P2** | SFTP 体验 | 补齐 SFTP 拖拽上传（`SftpDragAndDropController`）目录递归与视图自动刷新 | `src/sftp/SftpDragAndDropController.ts`, `src/extension.ts` |
| `OPT-11` | **P2** | SFTP 体验 | 为远程文件预览（`SftpPreview`）与本地编辑增加大文件/二进制预检保护 | `src/sftp/SftpPreview.ts`, `src/sftp/SftpEditSessionManager.ts` |
| `OPT-12` | **P2** | 端口转发 | 增强本地端口转发管理（支持单服多端口转发与状态栏可视化） | `src/extension.ts`, `src/ssh/LocalPortForward.ts` |
| `OPT-13` | **P3** | 工程治理 | 模块化拆分 `src/extension.ts`（1,100 行）并清理本地根目录历史 `.vsix` 产物 | `src/extension.ts`, 根目录 `*.vsix` |

---

## 二、 详细优化建议与执行规范

### P0：宿主稳定性、资源释放与连接池一致性

---

#### `OPT-01`：为全部 4 处 `ssh2.Client` 补齐常驻 `error` / `close` 监听，防止 Extension Host 崩溃与僵尸会话

- **代码定位**：
  - [`src/ssh/SshSession.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/ssh/SshSession.ts#L50-L86)
  - [`src/ssh/SshConnectionConfig.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/ssh/SshConnectionConfig.ts#L141-L176)（`jumpClient`）
  - [`src/sftp/SftpSession.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/sftp/SftpSession.ts#L57-L90)
  - [`src/extension.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts#L565-L599)（`sshManager.forwardLocalPort`）
- **问题分析**：
  1. `ssh2.Client` 继承自 Node `EventEmitter`。当跳板机转发通道断开或底层 TCP socket 在握手期间/连接后异常重置时，`ssh2` 会在首个错误之后再次触发 `error` 事件（例如 `Connection lost before handshake`，`fatal: true`）。
  2. 目前上述 **4 处建连点均只注册了单次 `client.once('error', reject)`**，没有挂载常驻 `client.on('error', ...)` 监听器（对比之下仅 `RemoteCommandExecutor.ts:243` 挂载了常驻监听）：
     - 握手半途二次触发 `'error'` 或连接建立后底层报错时，因无监听器将直接抛出 `uncaughtException`，导致整个 VS Code Extension Host 崩溃重启，波及同进程下所有正在运行的其他扩展。
  3. **`SftpSession`**（`src/sftp/SftpSession.ts:88-90`）的 `isConnected()` 仅检查 `Boolean(this.client && this.sftp)`，未监听 `client`/`sftp` 的 `close` 与 `end` 事件置空 `this.sftp`。网络闪断后，`SftpManager` 与 `SftpAgentService` 会持续复用已死会话并一直报错，无法感知断连并自动重连。
  4. **`forwardLocalPort`**（`src/extension.ts:566-599`）未监听 `client` 的 `close`/`error`，SSH 断开后本地 TCP 端口依然保持监听，每次代理连接都会在 `forwardOut` 阶段失败。
- **实施方案**：
  1. **`SshSession.ts`**：在 `connect()` 创建 `client` 后立即挂载常驻 `client.on('error', (error) => { if (this.connected) this.events.error(error); })`（预连接阶段错误仍由 `once('error', reject)` 上报，防止重复提示，同时彻底吞掉未消费的二次 `error` 防止进程崩溃）。
  2. **`SshConnectionConfig.ts`**：在创建 `jumpClient` 后立即挂载 `jumpClient.on('error', () => undefined)` 常驻兜底（可同时支持传入断连回调通知上层）。
  3. **`SftpSession.ts`**：在 `connect()` 中为 `client` 和 `sftp` 注册常驻 `error`、`close`、`end` 监听器，一旦断连立即置空 `this.sftp` 与 `this.client`、释放 `connectionHandle` 并触发可选的 `onDisconnected` 回调；`SftpManager` 与 `SftpAgentService` 在使用前检查 `session.isConnected()` 或订阅断连回调自动驱逐死连接。
  4. **`src/extension.ts`（`forwardLocalPort`）**：为转发用的 `client` 挂载常驻 `error` / `close` 监听，底层连接断开时自动调用 `forward.stop()`、`handle.dispose()`、从 `localForwards` 清除并弹出通知。
- **验收标准**：
  - 在 [`test/ssh/SshSession.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/ssh/SshSession.test.ts)、[`test/ssh/SshConnectionConfig.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/ssh/SshConnectionConfig.test.ts) 与 [`test/sftp/SftpSession.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/sftp/SftpSession.test.ts) 中模拟建连期间二次触发 `client.emit('error')` 与连接后触发 `close`，验证进程不抛出未捕获异常且 `SftpSession.isConnected()` 正确变为 `false`。
  - 验证 `SftpManager` / `SftpAgentService` 遇到断连后能在下次请求自动重建连接。

---

#### `OPT-02`：修复 `idleDisconnectMinutes` 误杀持续输出会话及终端断连未释放 Agent SFTP 连接

- **代码定位**：
  - [`src/webview/TerminalPanel.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/webview/TerminalPanel.ts#L433-L435)、[`L477-L480`](file:///Users/clkj/项目/at/at-terminal-series/src/webview/TerminalPanel.ts#L477-L480)、[`L562-L574`](file:///Users/clkj/项目/at/at-terminal-series/src/webview/TerminalPanel.ts#L562-L574)
  - [`src/extension.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts#L133-L145)、[`L876-L900`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts#L876-L900)
  - [`src/agent/SftpAgentService.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/SftpAgentService.ts#L371-L382)
- **问题分析**：
  1. **只计键盘输入不计远程输出导致长任务误杀**：`TerminalPanel.scheduleIdleDisconnect()` 仅在收到 Webview 的 `input`/`resize`/`ready` 消息时刷新（`L433-435`），收到远程 `output` 数据时（`L477-480`）**未重置空闲计时器**。当用户运行 `tail -f`、远程编译或数据库备份等只看输出不敲键盘的任务超过 `idleDisconnectMinutes`（默认 60 分钟）时，会话会被强行断开。
  2. **终端断开（标签页未关闭）未清理 `SftpAgentService` 终端连接池**：
     - `src/extension.ts:144` 仅在 `onTerminalRemoved`（关闭 Webview 标签页）时调用 `sftpAgentService?.disposeTerminal(terminalId)`。
     - 当终端因空闲超时、网络断连或用户执行 `sshManager.disconnect` 断开时，标签页仍保持打开，`TerminalContextRegistry` 仅触发 `onDidChangeContext(connected: false)` 而不触发 `onDidRemoveContext`。这会导致 `SftpAgentService.terminalSessions` 中为该 `terminalId` 缓存的独立 SFTP SSH 会话长期滞留不释放。
- **实施方案**：
  1. 在 `TerminalPanel` 中维护 `lastActivityAt = Date.now()`：在 `output` 回调和 `handleTerminalMessage` 时更新 `lastActivityAt`；`idleDisconnectTimer` 改为按检查间隔（例如每 30 秒检查一次 `Date.now() - lastActivityAt >= thresholdMs`，或者节流重设 `setTimeout`），避免高速输出下每包频繁 `clearTimeout`/`setTimeout`，同时确保双向有流量均不会触发误断。
  2. 在 `SftpAgentService` 构造订阅或 `registerSftpContextWiring` 的 `onDidChangeContext` 回调中，当 `!changedContext.connected` 时立即调用 `sftpAgentService?.disposeTerminal(changedContext.terminalId)`，确保终端一旦断开即刻释放对应的 Agent SFTP 连接与缓存的 `roots`。
- **验收标准**：
  - 在 [`test/webview/TerminalPanel.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/webview/TerminalPanel.test.ts) 中新增测试：模拟持续收到远程 `output` 时不会触发空闲断开，仅双向均无流量超期才断开。
  - 在 [`test/agent/SftpAgentService.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/agent/SftpAgentService.test.ts) 与 [`test/extension/AgentConnectionCleanup.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/extension/AgentConnectionCleanup.test.ts) 中断言终端转为 `connected: false` 时 `disposeTerminal` 被触发并关闭 SFTP 会话。

---

#### `OPT-03`：服务器配置修改/删除时联动驱逐 `RemoteCommandExecutor` 连接池

- **代码定位**：
  - [`src/agent/RemoteCommandExecutor.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/RemoteCommandExecutor.ts#L84-L91)、[`L268-L283`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/RemoteCommandExecutor.ts#L268-L283)
  - [`src/extension.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts#L349-L355)、[`L378-L382`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts#L378-L382)
- **问题分析**：
  - 在 `sshManager.editServer` 与 `sshManager.deleteServer` 中，当前仅调用了 `sftpAgentService?.disposeServer(server.id)`，**漏掉了清理 `remoteCommandExecutor` 中按 `serverId` 缓存的连接池**。
  - 修改了服务器的密码、私钥、用户名、Host 或跳板机配置，或删除服务器后，在 5 分钟空闲 TTL 到期前，MCP 工具 `run_remote_command` 仍会复用缓存中的旧连接。
- **实施方案**：
  1. 在 `RemoteCommandExecutor` 中新增公开方法 `disposeServer(serverId: string): void`：查找 `this.pool.get(serverId)`，若存在则调用 `this.evict(serverId, connection)`。
  2. 在 `src/extension.ts` 的 `editServer` 保存成功回调与 `deleteServer` 删除确认分支中同步调用 `remoteCommandExecutor.disposeServer(server.id)`。
- **验收标准**：
  - 在 [`test/agent/RemoteCommandExecutor.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/agent/RemoteCommandExecutor.test.ts) 中新增 `disposeServer` 单测，验证调用后立即 `client.end()` 且下次命令以新配置重建连接。

---

### P1：安全性加固与 SSH/SFTP 连接引擎优化

---

#### `OPT-04`：加固 SFTP `sudo -n` 回退写入 `/tmp` 临时文件权限（`0o600`）与覆盖安全性

- **代码定位**：
  - [`src/sftp/SftpSession.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/sftp/SftpSession.ts#L351-L404)、[`L482-L504`](file:///Users/clkj/项目/at/at-terminal-series/src/sftp/SftpSession.ts#L482-L504)、[`L604-L645`](file:///Users/clkj/项目/at/at-terminal-series/src/sftp/SftpSession.ts#L604-L645)
- **问题分析**：
  1. 用户在 SFTP 视图编辑或上传系统文件（如 `/etc/nginx/nginx.conf`）遭遇权限不足时，由于启用了 `allowSudoFallback: true`，会先将内容写入 `/tmp/at-terminal-write-${uuid}-${name}` 或 `/tmp/at-terminal-upload-${uuid}-${name}`，再通过 `sudo -n sh -c 'set -e; cat tempPath > remotePath; rm -f tempPath'` 写入目标路径。
  2. 当前 `writeBuffer(sftp, tempPath, content)` 仅使用 `sftp.open(path, 'w', cb)`，`fastPut` 也未传入 `mode` 参数。受远端默认 `umask`（通常为 `0022`）影响，临时文件在写入期间和 `sudo` 清理前的权限为 `0644`，同机其他普通用户在这段窗口内**可直接读取 `/tmp` 中的敏感配置或密钥内容**。
- **实施方案**：
  1. 为 `writeBuffer` 增加可选 `mode?: number` 参数，在写入 `/tmp` 临时文件时使用 `{ flags: 'wx', mode: 0o600 }`（或 `sftp.open(path, 'w', { mode: 0o600 }, cb)` 配合 `sftp.chmod(path, 0o600)` 兼容不支持 `open` attrs 的 SFTP 服务端），确保仅属主可读写。
  2. 为 `fastPut` 增加可选 `mode?: number` 选项，在 `uploadFileWithSudo` 中传入 `0o600`。
  3. 仅对 `/tmp` 临时文件开启 `0o600` 强制限制；普通直接写入路径维持远端既有文件权限不变。
- **验收标准**：
  - 在 [`test/sftp/SftpSession.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/sftp/SftpSession.test.ts) 中验证 `sudo` 回退路径下创建 `/tmp` 临时文件时设置了 `0o600` 权限，且在成功与失败分支均执行清理。

---

#### `OPT-05`：跳板机（JumpHost）连接池复用与多级链式跳板支持

- **代码定位**：
  - [`src/ssh/SshConnectionConfig.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/ssh/SshConnectionConfig.ts#L118-L176)
- **问题分析**：
  1. 每次调用 `buildSshConnectionHandle` 都会新建一个独立的 `jumpClient`。对于配置了跳板机的目标服务器，当用户打开终端、展开 SFTP 树、同时由 MCP 执行命令和读取文件时，会向**同一台堡垒机并行发起 4 条独立的 SSH 握手连接**。如果堡垒机开启了 `keyboard-interactive` 2FA/OTP 或较低的 `MaxStartups`/`MaxSessions` 限制，极易导致重复二次认证弹窗或连接失败。
  2. 第 144 行 `{ ...jumpHost, jumpHostId: undefined }` 强行丢弃了跳板机自身的 `jumpHostId`，不支持多级跳板（A → B → C）。
- **实施方案**：
  1. 实现基于 `jumpHostId`（及关键连接属性签名）的 `JumpHostPool`（带引用计数与短空闲回收 TTL，如 60 秒）：
     - 同一跳板机的并发请求共享同一条 `jumpClient`，通过 `jumpClient.forwardOut(...)` 打开独立目标隧道；
     - 每个 `SshConnectionHandle.dispose()` 仅释放自身 tunnel 并递减跳板机引用计数；
     - 跳板机配置变更/删除时联动清理对应缓存项。
  2. 将 `buildSshConnectionHandle` 改造为支持链式跳板（维护 `visited: Set<string>` 防环路与最大深度上限 `MAX_JUMP_HOPS = 4`）。
- **验收标准**：
  - 在 [`test/ssh/SshConnectionConfig.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/ssh/SshConnectionConfig.test.ts) 中覆盖：同一跳板机多次并发建连仅创建 1 次 `jumpClient`；2 级跳板链式建连成功；存在环路配置（A → B → A）时抛出明确错误。

---

#### `OPT-06`：合并 MCP Agent 后台 SSH 连接池（命令执行与 SFTP 共享底层 `Client`）

- **代码定位**：
  - [`src/agent/RemoteCommandExecutor.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/RemoteCommandExecutor.ts#L47-L87)
  - [`src/agent/SftpAgentService.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/SftpAgentService.ts#L93-L101)、[`L440-L538`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/SftpAgentService.ts#L440-L538)
- **问题分析**：
  - `RemoteCommandExecutor` 与 `SftpAgentService` 的后台会话各自维护了一套 `5 分钟 TTL` 的 `ssh2.Client` 连接池。Agent 在单次排查中混合调用 `run_remote_command` 和 `sftp_read_file` 时，会对同一台服务器建立 2 条重复的后台 SSH 连接与认证会话。
- **实施方案**：
  1. 提取共享的 `AgentSshClientPool`（例如 `src/agent/AgentSshClientPool.ts`），统一管理后台模式下按 `serverId` 索引的已认证 `ssh2.Client`、引用计数、断连驱逐与 5 分钟空闲 TTL。
  2. `RemoteCommandExecutor` 从该池租借 `Client` 执行 `client.exec()`；`SftpAgentService` 的后台连接路径通过同一 `Client` 打开 `client.sftp()` 子系统通道（注意：终端绑定的 SFTP 会话仍跟随终端上下文生命周期，但同样可按需复用）。
  3. 配合 `OPT-03`，在服务器编辑/删除时调用 `agentSshClientPool.disposeServer(serverId)` 统一释放。
- **验收标准**：
  - 在 [`test/agent/AgentToolService.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/agent/AgentToolService.test.ts) 中验证同一 `serverId` 连续调用后台命令与后台 SFTP 时仅发生一次底层 SSH 建连。

---

### P1/P2：MCP 取消链路、Agent 工具增强与磁盘 I/O 优化

---

#### `OPT-07`：打通 `BridgeServer` HTTP 请求中断到 `AbortSignal` 的取消链路并优化解码/超时清理

- **代码定位**：
  - [`src/mcp/BridgeServer.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/mcp/BridgeServer.ts#L317-L333)、[`L510-L560`](file:///Users/clkj/项目/at/at-terminal-series/src/mcp/BridgeServer.ts#L510-L560)
  - [`src/agent/AgentToolService.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/AgentToolService.ts#L20-L26)、[`L84-L131`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/AgentToolService.ts#L84-L131)
  - [`src/agent/RemoteCommandExecutor.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/RemoteCommandExecutor.ts#L13-L18)、[`L113-L188`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/RemoteCommandExecutor.ts#L113-L188)、[`L308-L336`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/RemoteCommandExecutor.ts#L308-L336)
- **问题分析**：
  1. **全链路缺少 `AbortSignal` 取消支持**：当 AI 客户端（如 Cursor / Kiro / Claude）用户点击 Stop 取消当前工具调用，或者 Hub 请求超时断连时，`BridgeServer` 未监听 HTTP 连接关闭事件，也未向 `AgentToolService.runRemoteCommand` 与 `RemoteCommandExecutor.execute` 传递 `AbortSignal`。结果是：远端耗时命令继续跑满超时，未确认的 IDE 弹窗继续挂在界面上等待。
  2. **超时后远端进程残留风险**：`RemoteCommandExecutor` 超时仅调用 `stream?.close()`（`L115`），未先尝试发送信号（如 `stream?.signal?.('TERM')`），部分交互或子进程可能继续驻留远端。
  3. **多字节截断边界乱码**：`OutputBuffer.text()`（`L333-335`）直接按字节硬截断并 `Buffer.concat(...).toString('utf8')`，截断落在多字节 UTF-8 字符（如中文日志）中间时末尾会出现 ``（`\uFFFD`）。
- **实施方案**：
  1. 在 `BridgeServer.ts` 的 `handleNodeRequest` 中创建 `AbortController`，监听 `response.on('close', () => { if (!response.writableEnded) controller.abort(); })`，将 `signal` 透传给 `handleInvoke` -> `dispatchTool` -> `service.runRemoteCommand`。
  2. 在 `AgentToolService.ts` 的 `RunRemoteCommandInput` 与 `RemoteCommandExecutor.ts` 的 `RemoteCommandRequest` 中新增 `signal?: AbortSignal`：
     - 等待人类确认弹窗期间若 `signal` 触发，立即结束等待（并在用户之后迟到点击弹窗时提示已取消而不执行）；
     - 建连或命令执行期间若 `signal` 触发，立即发送 `TERM` / 关闭 `stream` 并 reject。
  3. 在 `OutputBuffer.text()` 中对发生 `truncated === true` 的末尾执行 UTF-8 续字节边界对齐回退（最多回退 1~3 字节），避免产生末尾半个字符乱码。
- **验收标准**：
  - 在 [`test/mcp/bridgeHttp.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/mcp/bridgeHttp.test.ts) 与 [`test/agent/RemoteCommandExecutor.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/agent/RemoteCommandExecutor.test.ts) 中验证：客户端主动断开 HTTP socket 后 `signal.aborted` 置为 `true`，正在运行的命令 stream 被关闭；确认弹窗在被中断时不继续执行后续命令；截断多字节中文输出不产生 `\uFFFD`。

---

#### `OPT-08`：为 `SftpAgentService` 补齐读超时、`~` 家目录展开与局部编辑/本地直传能力

- **代码定位**：
  - [`src/agent/SftpAgentService.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/SftpAgentService.ts#L102-L176)、[`L569-L593`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/SftpAgentService.ts#L569-L593)
  - [`src/mcp/toolCatalog.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/mcp/toolCatalog.ts)
  - [`src/mcp/BridgeServer.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/mcp/BridgeServer.ts#L334-L389)
- **问题分析**：
  1. **读操作缺乏超时保护**：`SftpAgentService` 所有写接口均包裹了 `withTimeout(..., WRITE_TIMEOUT_MS)`，但 `listDirectory`、`statPath`、`readFile` 没有任何超时控制。SFTP 通道异常挂起时 MCP 工具调用会永久卡死。
  2. **`~` 家目录路径未展开**：`resolvePath` 与 `resolveWritablePath`（`L569-593`）仅识别绝对路径 `/` 和相对路径，SFTP 协议本身不解析 `~`。当模型传 `path: "~/.bashrc"` 或 `"~"` 时会被错误拼接成 `${workspaceRoot}/~/.bashrc`。
  3. **缺少局部编辑与乐观锁机制**：`sftp_write_file` 目前只支持全量覆写，修改大型配置文件不仅多耗费模型输出 Token，而且无 `expectedSize` / `expectedModifiedAt` 版本校验，无法防止覆盖期间别人修改过的远端文件。
- **实施方案**：
  1. 为 `listDirectory`、`statPath`、`readFile`（以及 `rootFor` 的 `realpath('.')`）统一增加 `READ_TIMEOUT_MS = 30_000` 超时保护。
  2. 在 `resolvePath` 与 `resolveWritablePath` 中新增 `expandHome(path, workspaceRoot)`：支持 `'~'` 与 `'~/...'` 展开为 `workspaceRoot` 对应路径。
  3. 增强 MCP SFTP 工具集：
     - 为 `sftp_write_file` 增加可选版本锁参数（`expectedSize` / `expectedModifiedAt`）及宿主本地文件流式直传参数 `localPath`（读取本地文件前校验 `realpath` 拦截 `~/.ssh` 等敏感本地凭据，绕过模型上下文传输大文件）；
     - 新增 `sftp_edit_file` MCP 工具，支持基于 `oldText` / `newText` 的精准局部替换与版本冲突检查（注：新增工具或字段需同步更新 `src/mcp/toolCatalog.ts`、`src/mcp/bridgeSchemas.ts`、`src/mcp/BridgeServer.ts` 及对应技能文档）。
- **验收标准**：
  - 在 [`test/agent/SftpAgentService.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/agent/SftpAgentService.test.ts) 与 [`test/mcp/toolCatalog.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/mcp/toolCatalog.test.ts) 中覆盖读超时、`~/...` 展开、`sftp_edit_file` 局部替换与版本冲突报错。

---

#### `OPT-09`：优化 `AgentAuditLog` 磁盘写入系统调用并增加日志大小轮转

- **代码定位**：
  - [`src/agent/AgentAuditLog.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/agent/AgentAuditLog.ts#L52-L91)
- **问题分析**：
  - 每次 `record()` 都串行执行 `await this.fs.mkdir(dirname(this.filePath), { recursive: true })` 与 `appendFile`。
  - `agent-audit.jsonl` 缺少大小上限与轮转机制，长期高频使用 Agent 运维会导致日志文件无限增长。
- **实施方案**：
  1. 缓存目录就绪状态（`private dirEnsured = false`），首次建目录成功后跳过重复 `mkdir`，仅当 `appendFile` 抛出 `ENOENT` 时重置标志并重建目录。
  2. 增加大小轮转：记录当前文件累计字节数（启动首次写入前通过 `stat` 初始化，超过阈值如 `10 MiB` 时将 `agent-audit.jsonl` 重命名为 `agent-audit.jsonl.1` 覆盖旧备份后再开启新文件）。
- **验收标准**：
  - 在 [`test/agent/AgentAuditLog.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/agent/AgentAuditLog.test.ts) 中验证多次 `record()` 仅触发一次 `mkdir`，以及日志超出阈值后正确触发重命名轮转。

---

### P2：VS Code SFTP 与端口转发交互体验优化

---

#### `OPT-10`：补齐 SFTP 拖拽上传（`SftpDragAndDropController`）的文件夹递归上传与视图自动刷新

- **代码定位**：
  - [`src/sftp/SftpDragAndDropController.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/sftp/SftpDragAndDropController.ts#L41-L85)
  - [`src/extension.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts#L107-L111)、[`L658-L705`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts#L658-L705)
- **问题分析**：
  1. 通过菜单命令 `sshManager.sftp.upload` 上传时（`src/extension.ts:673-680`），代码会 `stat(file.fsPath)` 区分文件夹与普通文件，分别调用 `uploadDirectory` / `uploadFile`，并在完成后刷新树节点。
  2. 而拖拽上传 `SftpDragAndDropController.handleDrop`（`L60-84`）：
     - 未判断 `localUri.scheme === 'file'`，且对所有拖入项直接调用 `uploadFile`，**拖入文件夹直接报错失败**；
     - 拖拽上传完成后**未调用 `sftpTreeProvider.refresh()`**，新上传的文件不会自动出现在 SFTP 树中（直到 20 秒缓存过期或手动点刷新）。
- **实施方案**：
  1. 在 `SftpDragAndDropController` 构造函数中注入可选刷新回调 `onUploaded?: (target?: SftpTreeNode) => void`（在 `src/extension.ts` 绑定 `sftpTreeProvider.refresh(...)`）。
  2. 抽取共用的本地条目上传与冲突提示辅助函数（供 `sshManager.sftp.upload` 与 `handleDrop` 共同复用，消除重复弹窗逻辑），通过 `stat(localUri.fsPath)` 区分目录与文件并分别调用 `uploadDirectory` / `uploadFile`。
  3. 拖拽上传结束（或至少有一个条目成功上传）后调用 `onUploaded` 刷新对应目录节点。
- **验收标准**：
  - 在 [`test/sftp/SftpDragAndDropController.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/sftp/SftpDragAndDropController.test.ts) 中覆盖：拖入本地目录触发 `uploadDirectory`、非 `file:` URI 安全跳过或报错提示、上传完成后调用 `onUploaded` 刷新视图。

---

#### `OPT-11`：为 SFTP 远程预览（`SftpPreview`）与本地编辑增加大文件/二进制预检保护

- **代码定位**：
  - [`src/sftp/SftpPreview.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/sftp/SftpPreview.ts#L22-L28)、[`L65-L78`](file:///Users/clkj/项目/at/at-terminal-series/src/sftp/SftpPreview.ts#L65-L78)
  - [`src/sftp/SftpEditSessionManager.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/sftp/SftpEditSessionManager.ts#L128-L151)
- **问题分析**：
  - `openRemotePreviewFile` 下载前未调用 `stat` 检查大小；下载后 `provideTextDocumentContent` 直接执行 `readFile(localPath, 'utf8')` 将全文加载为 JS 字符串。
  - `SftpEditSessionManager.openRemoteFile` 虽然调用了 `stat(remotePath)`（`L130`），但也没有根据文件体积或扩展名做拦截提醒。
  - 误操作预览或编辑数百 MB 的归档文件（`.tar.gz`, `.zip`, `.bin`）或大日志会长时间卡住 SFTP 通道并带来 Extension Host OOM 风险。
- **实施方案**：
  1. 为 `openRemotePreviewFile` 注入 `statFile` 预检大小；设定软上限（例如预览默认 `20 MiB`、编辑默认 `50 MiB`）。
  2. 超过软上限或命中常见二进制归档/镜像后缀时，弹窗提示实际文件体积并询问用户“继续打开”或“取消”（提示改用“下载到本地”）。
  3. 在 `extension.ts` `deactivate()` 时增加临时预览缓存目录清理兜底。
- **验收标准**：
  - 在 [`test/sftp/SftpPreview.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/sftp/SftpPreview.test.ts) 与 [`test/sftp/SftpEditSessionManager.test.ts`](file:///Users/clkj/项目/at/at-terminal-series/test/sftp/SftpEditSessionManager.test.ts) 中验证大文件取消时不触发 `downloadFile`。

---

#### `OPT-12`：增强本地端口转发管理（支持单服多端口转发与状态栏可视化）

- **代码定位**：
  - [`src/extension.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts#L61)、[`L520-L600`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts#L520-L600)
  - [`src/ssh/LocalPortForward.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/ssh/LocalPortForward.ts)
- **问题分析**：
  1. 当前 `localForwards` 以 `server.id` 为唯一 key，导致**每台服务器最多只能开启 1 条端口转发**（无法同时转发同台服务器上的 MySQL `3306` 与 Redis `6379`）。
  2. 再次执行 `sshManager.forwardLocalPort` 时会直接无提示关闭当前转发；界面上没有任何状态栏入口显示当前活跃转发及本地随机分配的端口。
- **实施方案**：
  1. 抽取 `PortForwardManager`（支持每台服务器绑定多条转发，按 `forwardId` 管理并记录 `localPort`、`remoteHost`、`remotePort`、`serverLabel`）。
  2. 触发 `sshManager.forwardLocalPort` 且该服务器已有活跃转发时，弹出 `QuickPick`：提供 `Add New Forward` 与已有转发列表（点击可停止对应单条转发或复制 `127.0.0.1:<localPort>`）。
  3. 注册一个按需显示的 VS Code 状态栏项（当活跃转发数 > 0 时显示 `$(plug) AT Forwards: N`），点击即可弹出全部活跃转发管理菜单。
- **验收标准**：
  - 新增单测覆盖单服务器多条并发转发、独立停止单条转发以及配合 `OPT-01` 底层 SSH 断开时的自动清理与状态栏同步。

---

### P3：工程架构与产物治理

---

#### `OPT-13`：模块化拆分 `src/extension.ts` 并清理本地根目录历史 `.vsix` 产物

- **代码定位**：
  - [`src/extension.ts`](file:///Users/clkj/项目/at/at-terminal-series/src/extension.ts)（全文件 1,100 行）
  - 根目录本地未跟踪安装包：`at-terminal-0.3.0.vsix` ~ `at-terminal-0.3.5.vsix`、`at-terminal-mcp-0.3.0.vsix` ~ `at-terminal-mcp-0.3.5.vsix`（共 12 个文件，约 6.8 MB）
- **问题分析**：
  1. `src/extension.ts` 集中了树视图注册、MCP 启动、服务器管理、SSH Config 导入、HostKey 恢复弹窗、端口转发及全量 SFTP 命令（1,100 行），可读性与模块化程度偏低。
  2. 仓库根目录保留了大量历史打包产物 `.vsix`（虽已被 `.gitignore` 忽略，但容易在 IDE 文件树或工作区搜索中形成干扰）。
- **实施方案**：
  1. 将 `src/extension.ts` 中的命令按领域拆分为独立模块（保持 `src/extension.ts` 仅作为 < 250 行的组合根）：
     - `src/commands/serverCommands.ts`
     - `src/commands/sftpCommands.ts`
     - `src/commands/portForwardCommands.ts`
     - `src/commands/mcpCommands.ts`
  2. 清理工作区根目录堆积的历史 `.vsix` 文件（或统一移入 `dist/`/`releases/` 下不与源码混放）。
- **验收标准**：
  - 拆分后 `npm run typecheck`、`npm test`（含 `test/extension/*` 与 `test/package.*.test.ts`）、`npm run build:base`、`npm run build:mcp` 全部通过。

---

## 三、 分阶段执行与回归验证清单

建议按以下 4 个批次推进，每完成一批运行全量校验：

1. **Batch 1（P0 紧急稳定性）**：完成 `OPT-01` → `OPT-03`
2. **Batch 2（P1 安全与连接池）**：完成 `OPT-04` → `OPT-06`
3. **Batch 3（P1/P2 MCP 与 SFTP 体验）**：完成 `OPT-07` → `OPT-12`
4. **Batch 4（P3 工程治理）**：完成 `OPT-13`

### 回归验证命令（`main` 分支）

```bash
cd /Users/clkj/项目/at/at-terminal-series

# 1. TypeScript 静态类型检查
npm run typecheck

# 2. 全量单元、集成与变体打包测试
npm test

# 3. 验证 Base 与 MCP 双版本编译打包
npm run build:base
npm run build:mcp
```
