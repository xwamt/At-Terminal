# AT Terminal 0.3.4 优化建议（性能 × 功能 × 用户友好度）

三路只读评审交叉结论。安全工程质量（fail-closed 主机指纹、按目录写授权、agent 禁提权、ADR-003）显著高于同类；短板集中在**认证兼容、文档/实现对齐、出错后无出路、终端吞吐、SFTP 目录操作**。

## 交叉结论

三路独立评审反复撞上同一批问题，说明它们不是局部瑕疵：

| 交叉项 | 性能 | 功能 | UX | 合并优先级 |
| --- | --- | --- | --- | --- |
| 主机密钥变更后永久锁死，无 Forget 命令 | — | 缺口 | P0 | **P0** |
| 文档宣称目录下载 / rz·sz，实现缺失或会报错 | — | P0 | 文档失配 | **P0** |
| Limited trust 文案与真实策略相反 | — | 安全叙事 | P0 | **P0** |
| 命令面板大量静默空操作 | — | — | P0 | **P0** |
| 加密私钥 passphrase / ssh-agent / 2FA 缺失 | — | P0 | 首次即流失 | **P0** |
| 终端 DOM renderer + 无背压 | P0/P1 | — | 大输出卡死 | **P0** |
| 后台连接只覆盖命令、不覆盖 sftp_* | 会话泄漏 | P1 | Agent 首日失败 | **P1** |
| SFTP 树全量刷新零缓存 + 单击无动作 | P1 | 符号链接当文件 | P1 | **P1** |
| 错误 toast 3 秒消失、无按钮 | — | 指纹管理暗道 | P0 | **P0** |
| 中英混杂 + 断开状态灯错色 | — | — | P1 | **P1** |

**产品边界（明确不要做）**：远端装 server、原生 Chat、FileSystemProvider 全量挂载、tmux/Mosh/X11、SFTP 双向自动同步、把本地端口转发暴露给 Agent、合并终端/agent/SFTP 到同一条 SSH 连接。

---

## P0 — 建议立刻做

### 1. 主机密钥变更给出路

`extension.ts` 指纹变更走 3 秒 error toast，且全仓无 Forget 命令（`forget()` 只在删服务器时调用）。用户被永久锁死。

- 改为带按钮的持久 `showErrorMessage`：「查看指纹」「信任新密钥」「忘记并重连」
- 服务器右键增加 `SSH: Forget Host Key` / `View Host Fingerprint`
- 变更默认仍阻断，绝不自动信任

### 2. 文档与实现对齐（小改动、高信任收益）

已核实的失配：

1. `docs/features*` 宣称 `rz`/`sz` —— 源码零实现
2. 「下载远程文件或目录」——目录走 `fastGet`，必然失败（`extension.ts` `sshManager.sftp.download`）
3. Limited trust：表单/`toolCatalog` 写「黑名单外直接跑」，`docs/features.zh-CN.md` 写「未知一律 review」——以代码为准改文档，或反过来改策略并改三处文案
4. catalog/SKILL 说 `sftp_read_file` 可 "read a smaller range"，工具没有 offset
5. `usage*` 命令名 `AT Terminal: Install MCP Config` ≠ 实际 `Install/Repair AT Series MCP Config`
6. `usage*` Settings 漏 `idleDisconnectMinutes`；README hub 版本、飞书链接拼接损坏、vsix 版本号过期

扩展 `test/docs/McpDocs.test.ts`：禁止未实现能力出现在 features；settings 列表与 `package.json` contributes 对 diff。

### 3. 认证补齐：passphrase、ssh-agent、keyboard-interactive

`SshConnectionConfig` 读私钥不传 `passphrase`；无 `SSH_AUTH_SOCK`；无 `tryKeyboard`。企业环境第一次连接即失败。

- passphrase 入 SecretStorage；加密私钥失败时弹 InputBox
- `authType: 'agent'` 透传 ssh2 agent
- `tryKeyboard: true` → InputBox；后台连接无 UI 则明确报错，不挂起

### 4. 命令面板不再静默失败

`sshManager.connect` / edit / delete / SFTP 多数命令 `if (!item) return;`，却暴露在命令面板。

- 无参时 QuickPick 选服务器；或 `menus.commandPalette` + `when: false` 隐藏纯上下文命令
- 错误改用原生 `showErrorMessage` + 动作按钮；定时消失只留给成功提示

### 5. 终端吞吐：WebGL + 背压 + 二进制 postMessage

- 引入 `@xterm/addon-webgl`，失败回退 DOM；zebra 做成设置（默认关，与 WebGL 互斥）
- 去掉无必要的 `allowTransparency`
- 水位线协议：`term.write` 回调 ack，高水位 `shell.pause()` / 低水位 `resume()`
- `outputBytes` 改传 `Uint8Array`，去掉 base64 往返（`engines: ^1.85` 已支持）

---

## P1 — 核心体验与 Agent 闭环

### 6. SFTP 目录级操作（修复宣传能力）

递归上传/下载（限并发 + 汇总进度）、非空目录删除前展示条目数、上传前冲突提示。先补失败用例再修。

### 7. 后台形态补齐 SFTP

`SftpAgentService.resolveTarget` 只认已连接 UI 终端，与 README「IDE 作服务基座」不符。

- `backgroundConnectionAllowed` 时按 serverId 建后台 `SftpSession`（`allowSudoFallback: false`）
- 写授权照旧；闲置 TTL 对齐 `RemoteCommandExecutor`（5 分钟）
- **同时修泄漏**：`onDidRemoveContext` 未清理 `sftpAgentService.sessions`，终端关闭后 sshd 会话残留

### 8. SFTP 树：缓存 + 增量刷新 + 单击打开

- `(terminalId, path)` listing 缓存 15–30s，变更后定向失效
- 切回同一终端且 rootPath 未变时跳过刷新
- 文件单击 = Preview，右键/双击 = Edit；tooltip 写清「编辑会回传」

### 9. 首次体验与 MCP 装对版本

- `Servers` / `SFTP Files` 加 `viewsWelcome`
- MCP 版 `displayName` 加后缀，避免与基础版同名
- MCP 命令 title 加 `AT Terminal:` 前缀并同步文档；hub 失败通知带「立即修复」按钮
- 统一命令 `category: "AT Terminal"`

### 10. 中文界面与状态指示

- 终端状态改为结构化枚举，停止用英文字面匹配（中文「已断开连接」当前被当成 connecting）
- `SshSession` / 传输完成句 / 远程编辑 / 命令确认 / 写入授权 全部走 `t()`
- 服务器树显示已连接徽标；断开终端 webview 给「重新连接」按钮

### 11. Agent 读工具：offset / tail

`sftp_read_file` 加 `offset`（负值从尾部）；list 加分页。catalog 已在教 Agent range，实现跟上。

---

## P2 — 按需

| 项 | 说明 |
| --- | --- |
| 断线自动重连（3 次退避）+ `@xterm/addon-search` + 可选会话日志 | 须走现有 hostKeyVerifier |
| `sftp_read`/`writeBuffer` 滑动窗口 4–8 并发 | 高延迟链路 4–8× |
| ssh2 首次建连懒加载；hub sync 用 version+mtime 快路径 | 激活期少 40–60ms |
| 编辑校验先 `stat` 再决定是否 `readFile`；传输进度 ≥100ms 节流 | 内存/通知开销 |
| `sftp_rename` / 收紧的 `sftp_delete`；命令确认 120s 超时 | 删除不进 directory grant；full trust 是否豁免删除需单独决策 |
| Agent 审计 JSONL + OutputChannel | full trust + 后台连接的事后凭证 |
| UI 本地端口转发（不暴露 MCP） | `forwardOut` 已验证可行 |
| GBK/Big5 终端编码 | schema 现焊死 utf-8 |
| `~/.ssh/config` 导入 | 迁移阻力 |
| 通知降噪 | mkdir/rename 成功不 toast；批量上传聚合进度 |
| 资产导出密码不匹配提示并允许重输 | 现为静默退出 |

---

## 不建议现在做

- 远端 Remote Agent / 原生 Chat / 全量 FileSystemProvider 挂载
- 合并终端、agent、SFTP 到同一 SSH 连接（生命周期与 sudo 语义不同）
- 优化策略 WASM / 语义高亮 / zod（均已有上限，实测 0.1–数 ms）
- 主 bundle 再拆 js-yaml/semver；esbuild 多 chunk
- 下调 hub 5s 健康轮询（不在本仓，开销可忽略）

## 建议落地顺序

1. **信任修复**：P0-1 指纹出路、P0-2 文档/文案对齐、P0-4 命令面板与错误按钮
2. **连得上**：P0-3 认证
3. **终端能用**：P0-5 WebGL + 背压 + 二进制消息（背压与二进制同批）
4. **SFTP 名实相符**：P1-6 目录操作、P1-8 树缓存与单击
5. **Agent 闭环**：P1-7 后台 SFTP + 泄漏、P1-11 offset
6. **首日**：P1-9 walkthrough / 版本名、P1-10 i18n

测试：目录下载/非空删除先补失败用例；`@vscode/test-electron` 已声明未使用，真实 sshd 对接仍空缺。
