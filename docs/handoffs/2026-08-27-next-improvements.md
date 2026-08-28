# AT Terminal 后续完善建议（0.3.4 之后）

四路只读评审交叉结论。评审对象是 `cursor/implement-optimizations-11f8` @ `27deea6`（已落地 2026-08-27 优化切片：主机密钥出路、认证补齐、目录 SFTP、WebGL 终端、后台 SFTP、offset/rename/delete、审计日志等）。`npx tsc --noEmit` 干净，`npx vitest run` **717/717**。下文**不再重复那些已落地项**，只谈「还能连上、日常能用、Agent 能闭环、能安心发版」还缺什么。

**实现入口（给后续 Agent）**：先读 [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md)（基线分支、文件所有权、禁止项），再只打开自己的 `plans/slice-*.md` 与对应 `_wiring-*.md`。从 `cursor/implement-optimizations-11f8` 拉分支，禁止改 `main`。

当前 `main`（0.3.4）尚未合并上述优化 PR。若以 `main` 为发布基线，应先合入该 PR，再按本文推进。

**产品边界（仍然不要做）**：远端 VS Code Server、原生 Chat、FileSystemProvider 全量挂载、tmux/Mosh/X11、SFTP 双向自动同步、把本地端口转发暴露给 Agent、合并终端/agent/SFTP 到同一条 SSH 连接。也不要做递归目录删除的 MCP 工具。

---

## 交叉结论

四路独立评审反复撞上同一批问题，说明它们不是局部瑕疵。优化切片把「连得上 / 名实相符」抬了一档之后，短板转到 **企业认证只覆盖终端、人机体验落后于 Agent、发版无人验证、安全同意弹窗仍是英文**。

| 交叉项 | SSH/SFTP/终端 | Agent/MCP | UX | 工程 | 合并优先级 |
| --- | --- | --- | --- | --- | --- |
| Agent 写/执行同意弹窗仍是英文 | — | 写提示未走 `t()` | **P0 信任** | — | **P0** |
| SFTP/Agent 连不上 2FA；口令/passphrase 从不弹窗 | **P1** | KI 后台 fail-fast 正确 | 认证失败只有 Reconnect | SFTP 会话工厂未接线 | **P1** |
| 命令超时进程可能仍在跑；SFTP 读/连无超时 | 传输不可取消 | **P1 双执行** | 空闲断开只看键盘 | 无真实 sshd 测试 | **P1** |
| 单击预览每次 toast；树单击新开一条 SSH | 拖拽未跟目录/冲突 | 多服务器隐式 `serverId` | **P1 噪声/误连** | — | **P1** |
| 发版产物从未在 CI 打过包；基础版从未跑过 | — | VS Code 本身装不上 MCP | MCP 安装死胡同 | **P0 发版** | **P0** |
| 文档：Limited-trust 表仍是白名单叙事；已交付能力漏写 | **P1** | skill 命令名与测试互相矛盾 | 欢迎页/空状态 | — | **P1** |
| 跳板多跳静默压成一跳；symlink 叶节点绕过敏感路径 | 静默截断 | 写路径只 realpath 父目录 | — | **P1 安全** | **P1** |

已经扎实、不必再转的部分：主机指纹 fail-closed、Agent SFTP 禁止提权、按目录写授权、删除始终确认且不进 grant、bridge 恒定时间鉴权、连接池 + 闲置 TTL、payload 上限与 drift 测试文化。

---

## P0 — 建议立刻做

### 1. 把安全同意弹窗做成中文

写授权范围按钮（Allow Once / 15 Minutes / Session）、敏感路径二次确认、远程命令确认正文目前是硬编码英文；**删除**提示已经走了 `t()`。中文用户在这里授权 AI 写服务器，混排语言是信任问题，不是文案问题。

- `src/agent/SftpWriteAuthorizer.ts` 的 `SCOPE_LABELS`、`formatWritePrompt`
- `src/utils/commandPreview.ts` 的确认框正文
- 按钮与框体必须本地化；`@at-series/command-policy` 的 `riskSummaries` 可暂留英文并写明

### 2. 发版产物要有人验证

单元测试全绿不等于能装。现状：

- `vitest.config.ts` 写死 `MCP_ENABLED: true`，基础版从未执行
- `scripts/package-variant.mjs` 不在 CI 里跑
- 三个 manifest 的 `version` 靠手齐，variants 测试不检查相等

下一步：CI 打 `package:base` / `package:mcp`，解包核对文件清单；加一组 `MCP_ENABLED: false` 的激活冒烟；variants 测试断言版本一致。`npx @vscode/vsce` 应钉进 `devDependencies`。

---

## P1 — 核心体验与 Agent 闭环

### 连得上（人）

1. **用户驱动的 SFTP 接上 keyboard-interactive**。终端已能 2FA，SFTP 树/上传/编辑仍 `attachKeyboardInteractive(..., undefined)`，企业 OTP 服务器上半个产品是黑的。只给 `SftpManager` 接线，Agent 后台继续 fail-fast。
2. **连接时补口令 / passphrase**。表单和 SecretStorage 已有字段，导入的加密私钥从不弹窗，失败信息是 ssh2 原文。终端连接路径检测 bad passphrase / missing password → InputBox，可选保存。
3. **SFTP 会话在断线后重建**。终端会自动重连，`SftpManager` 缓存死 session，文件视图一直失败。`SftpSession` 在 `close`/`error` 上标死，`ensureSession` 发现未连接则重建。
4. **Reload Window 后终端不丢**。没有 `registerWebviewPanelSerializer`。序列化 `serverId`，恢复面板后一键重连（仍走现有指纹/提示链，禁止静默自动认证）。
5. **认证失败给出路**。现在只有 Reconnect，会永远打到同一错误。分类 `ECONNREFUSED` / `ETIMEDOUT` / `ENOTFOUND` / auth failed，持久错误带「编辑服务器 / 重试」，密码认证允许当场重输。

### 日常不添乱（人）

6. **单击预览降噪**。每次点击都是完整传输通知 + 成功 toast，且 `preview: false` 堆标签。预览应静默下载、`preview: true`。
7. **树单击不要新开 SSH**。已连接服务器再点一次会再开一条连接，并抢 SFTP 活动上下文。默认显示已有面板；「新建终端」放右键。
8. **拖拽上传对齐 Upload 命令**。目录递归、Overwrite/Skip/All。现在拖文件夹走 `fastPut` 失败，拖已存在文件变成生错误 toast。
9. **传输完成句走 `t()`**。中文用户看到「上传 /path completed.」；`delete` 失败显示 `delete failed.`。删除与 `requireConnected` 两条路径语言还不统一。
10. **`sshManager.keepAliveInterval` 要么接线要么删掉**。贡献了、文档写了，运行时只读表单里的每服务器值。
11. **空闲断开要把输出算作活动**（或改文案）。`tail -f` / 构建会被 60 分钟默认值杀掉。
12. **SFTP `viewsWelcome` 实际不可达**。`none` 状态返回占位 TreeItem，欢迎页被抑制。`none` 时返回 `[]`，欢迎里放连接命令链接。
13. **MCP 安装对 VS Code 说假话**。检测到 VS Code 却提示「打开工作区以安装 Continue」。应报出宿主名、支持的 IDE，并提供复制手动配置 / 打开教程。

### Agent 闭环

14. **超时必须尽力杀掉远程进程**。现在只 `stream.close()`，`timedOut: true` 后 Agent 重试会双执行（`apt-get upgrade`）。先 `signal('KILL')`，catalog 写明「仍可能在跑」；skill 写 pidfile + `sftp_read_file` 负 offset 的作业模式。
15. **SFTP 连接/读加超时；主机密钥弹窗加 120s 上限**。写路径有 60s，读/connect 没有，bridge 的 `requestTimeout` 只管收包。这是命令确认超时刚修过的同一类挂起。
16. **写确认 120s、I/O 60s 拆开**。当前 `WRITE_TIMEOUT_MS` 把人话对话框和传输绑在一起。
17. **`sftp_stat_path` 补类型/权限**。现在只有 `size`/`modifiedAt`，内部已经靠列父目录绕过。补 `type`/`mode`/`uid`/`gid`/符号链接目标（只读，无新信任面）。
18. **`sftp_checksum`**。skill 要求校验和，实现只能 `sha256sum`（无信任每次弹窗）。走现有 SFTP 读、本地哈希。
19. **多服务器时 exec/write 禁止隐式默认目标**。漏传 `serverId` 会打到「当前默认」终端。读工具可保留便利。
20. **审计记下策略决策**。`reasonCode`/`action`/`trust` 算完就扔了，出事分不清 full-trust、策略放行还是运行时失败后用户点了允许。

### 安全边（小改动）

21. **写路径对已存在叶节点做 realpath / lstat**。现在只解析父目录再拼 basename，`~/deploy/config` → `/etc/cron.d/job` 会当成工作区内普通写，目录 grant 还会跳过后续提示。
22. **远程编辑缓存不要进用户仓库**。`<workspace>/.ssh-terminal-manager/` 无 `.gitignore`，「Keep Local Copy」会留下密钥/配置。创建目录时写 `*` 的 gitignore，或默认 `globalStorageUri`。
23. **跳板若自身还有跳板：拒绝或递归，禁止静默压扁**。表单给出提示。`SshConfigImport` 的 `ProxyCommand` 同样不要当直连导入。

### 文档

24. **`docs/features.md` 工具表仍写「能证明普通只读才免确认」**，Safety 节已经改成黑名单。这是上一轮 P0 漏网。改两行表 + 测试禁止该句。
25. **文档 presently 欠账**：已交付的 ssh-agent、passphrase、2FA、跳板、本地转发、指纹命令、目录传输、WebGL、查找、会话日志、编码均未写入 `features`/`usage`。补一轮，并把命令/设置列表与 `package.json` contributes 做 diff 测试。
26. **skill `setup.md` 仍用旧命令名**，且 `AtTerminalMcpSkill.test.ts` 钉死旧名、`McpDocs.test.ts` 禁止旧名。两套 drift 测试必须先和解。

---

## P2 — 按需

| 项 | 说明 |
| --- | --- |
| 独立「浏览文件」（不先开终端） | Agent 已能后台 SFTP，人还不行 |
| 终端 GBK/Big5 输入与 SFTP 文件名 | 现在只解码输出；要么 host 侧 iconv，要么表单写明「仅显示」 |
| 传输可取消；目录下载冲突；预览体积/二进制护栏 | 符号链接删除确认不要按目标内容计数 |
| 人机 rename 支持绝对路径移动；ignore globs（默认跳过 `.git`/`node_modules`） | Agent `sftp_rename` 已能 move |
| `sftp_chmod` / `sftp_copy` / append / base64 读 / `remote_grep` | 都走现有写授权或只读模型；进程/日志不必新工具 |
| 端口转发：每服务器多条、状态、断线提示 | 现实现是 stub（一服务器一条、死连接仍占 map） |
| 资产导出含 passphrase；导入/导出/SSH config 可多选 | 导出「Server configuration」选项实际无法取消 |
| 审计/会话日志轮转；`LogOutputChannel`；bridge 401 入审计 | JSONL 无上限 |
| 脱敏补 passphrase/URL/sshpass/Bearer；资产包写入 scrypt `{N,r,p}` | |
| sudo 暂存 `/tmp` 用 `mode: 0o600`；用户 SFTP 提权先询问或事后通知 | |
| 主机密钥按算法钉多把；known_hosts 导入 | 现一 `host:port` 一把 |
| 多窗口向 hub 发布已连接 `serverId`（无凭据） | 现只有 count |
| 列表分页先按名字排序；写确认剩余英文；html `lang` | |
| `extension.ts` 拆注册函数；统一 `withTimeout` / 取消错误类型 | |
| 真实 sshd 集成 + test-electron 冒烟；删 CI 里过时的 sibling hub 构建 | |
| 确定最终 publisher | `local` 侧载；以后改 ID 会丢状态，越拖越贵 |
| 粘贴多行确认、unicode11、查找计数、面板复用 Disconnect 菜单 | 粘贴护栏爆破半径最大 |
| `-R`/`-D`、压缩开关、SFTP 多选、屏幕阅读模式 | 低优先级 |

---

## 建议落地顺序

1. **信任与发版**：P0-1 同意弹窗中文、P0-2 CI 打包 + 基础版冒烟、P1-24 Limited-trust 表、P1-21/22 敏感路径与编辑缓存。
2. **连得上**：P1-1 SFTP 2FA、P1-2/5 凭据与认证出路、P1-3 死会话重建。
3. **Agent 不误导**：P1-14/15/16 超时与杀进程、P1-19 显式目标、P1-20 审计字段。
4. **日常噪声**：P1-6 预览、P1-7 树单击复用、P1-8 拖拽、P1-9 传输文案。
5. **能力补齐**：P1-17/18 stat+checksum，然后 P2 的 grep/chmod/独立浏览。
6. **到达更多宿主**：VS Code `mcp.json` 安装器（可能要先动 `@at-series/mcp-hub`）、欢迎页/空状态按钮、publisher 决策。

测试：连接分类与 KI-SFTP 先补失败用例；目录拖拽/冲突先写再修；有环境后再上 dockerized sshd（1 MB 管道读写、sudo、一跳跳板、超时杀进程）。

---

## 评审来源

只读评审，模型均为指定的高推理档；分析树为 `/home/ubuntu/workspace-integrate` @ `27deea6`。
