# 后续优化实现计划（给 Agent 直接落地）

本文是 **0.3.4 之后下一轮工作的实施合同**。实现 Agent 必须先读完本文，再只打开自己切片的细则，禁止改 `main`。

| 项 | 值 |
| --- | --- |
| 分析与优先级 | `docs/handoffs/2026-08-27-next-improvements.md` |
| 实现基线 | `cursor/implement-optimizations-11f8`（`27deea6` 或其后的该分支 HEAD），**不是** `main` |
| 合入目标分支 | 新建 `cursor/<slice>-11f8`，最终由集成者合入一条非 `main` 的集成分支（例如 `cursor/next-wave-11f8`） |
| 代码真相 | 以基线树源码为准；细则里的行号可能漂移，以符号名为准 |
| 验收 | 切片内新测通过；全仓 `npx tsc --noEmit` 与 `npx vitest run` 保持绿 |

**产品边界（任何切片都禁止实现）**：远端 VS Code Server、原生 Chat、FileSystemProvider 全量挂载、tmux/Mosh/X11、SFTP 双向自动同步、把本地端口转发做成 MCP 工具、终端/agent/SFTP 共用一条 SSH 连接、MCP `sftp_delete` 递归删目录。

**P2 不在本轮合同内**（见建议文档表格）。未写入切片「必须交付」列表的项，实现时不要顺手做。

---

## 实现 Agent 操作规程

1. 从 `origin/cursor/implement-optimizations-11f8` 拉工作分支，**不要** checkout `main`，**不要** 在 `main` 上 commit/push。
2. 只改本切片「文件所有权」列出的路径。需要改别人的文件时，把补丁写进 `docs/handoffs/_wiring-<slice>.md`，由集成者粘贴。
3. 新用户可见英文字符串一律 `t('English source')`。若本切片不拥有 `l10n/bundle.l10n.zh-cn.json`，把 English → 建议中文 列在 wiring 文件。
4. 先补失败/行为测试再改生产代码（尤其是拖拽冲突、超时杀进程、realpath 叶节点）。
5. 保持已有 717+ 测试绿色；`sftp_delete` 仍：只删文件、始终确认、不进 directory grant、full trust 也不免确认。
6. 主机密钥 **变更默认仍阻断**；新动作必须是用户显式选择。
7. 做完后：本切片测试 + `npx tsc --noEmit` + 全量 `npx vitest run`，再提交。

切片细则目录：

| 切片 | 细则 | 主题 |
| --- | --- | --- |
| A | `docs/handoffs/plans/slice-a-trust-i18n.md` | 安全同意中文化、传输文案、Limited-trust 文档与 skill 名和解 |
| B | `docs/handoffs/plans/slice-b-connectivity.md` | 凭据补齐、错误分类、跳板/ProxyCommand、连接失败文案 |
| C | `docs/handoffs/plans/slice-c-sftp-runtime.md` | SFTP 2FA、死会话重建、拖拽冲突、预览降噪、编辑缓存 gitignore |
| D | `docs/handoffs/plans/slice-d-agent-mcp.md` | 超时杀进程、读写超时、stat/checksum、显式 serverId、审计字段、叶节点 realpath |
| E | `docs/handoffs/plans/slice-e-ux-release.md` | 面板复用/序列化、空闲断开、欢迎页、MCP 宿主提示、keepAlive、CI 打包、文档补齐 |

集成顺序建议：A 与 B、C、D 可并行；E 依赖 A–D 的 `_wiring-*.md`，最后合。CI 打包（E）不阻塞功能切片。

接线文件（跨所有权补丁，由集成者/E 粘贴，**不要**重放上一轮的 `_wiring-agent.md` 等）：

| 文件 | 用途 |
| --- | --- |
| `docs/handoffs/_wiring-a.md` | SftpManager 删除标签、拖拽 requireConnected 走 `t()` |
| `docs/handoffs/_wiring-b.md` | 凭据 InputBox、错误分类器、表单跳板预警、l10n 键 |
| `docs/handoffs/_wiring-c.md` | SftpManager KI 注入、预览 quiet 第 4 参、符号链接删除文案 |
| `docs/handoffs/_wiring-d.md` | 主机密钥弹窗 120s、SftpSession lstat/readlink |
| `docs/handoffs/_wiring-e.md` | SFTP welcome 空数组、keepAlive 表单默认、分类器委托、E 的 l10n |

---

## 切片文件所有权（禁止越界）

### A — trust-i18n

- **拥有**：`src/agent/SftpWriteAuthorizer.ts`，`src/utils/commandPreview.ts`，`src/sftp/TransferService.ts`，`l10n/bundle.l10n.zh-cn.json`，`docs/features.md`，`docs/features.zh-CN.md`，`skills/at-terminal-mcp/references/setup.md`，`test/agent/SftpWriteAuthorizer.test.ts`，`test/docs/McpDocs.test.ts`，`test/docs/AtTerminalMcpSkill.test.ts`，以及这些文件的配套测试。
- **不拥有**：`src/extension.ts`，`src/agent/SftpAgentService.ts`，`package.json`。
- **必须交付**：P0 同意弹窗中文；传输 `{label} completed/failed`；删除标签本地化；Limited-trust 工具表与代码一致；skill 安装命令名与 `package.nls` 一致且两套 drift 测试不再互斥。

### B — connectivity

- **拥有**：`src/ssh/**`，`src/config/schema.ts`（仅当分类器需要导出类型），`src/utils/errors.ts`（若新增 `UserVisibleError` 子类），`test/ssh/**`。
- **不拥有**：`src/extension.ts`，`src/sftp/**`，`src/webview/**`。
- **必须交付**：缺失 password/passphrase 的可测试 hook（调用方可弹 InputBox）；ssh2 解析/认证失败分类器；跳板自带 jump 时拒绝或明确报错（禁止静默 `jumpHostId: undefined`）；`ProxyCommand` 导入警告；所有用户可见错误走 `t()` 或返回已分类的 `code`。

### C — sftp-runtime

- **拥有**：`src/sftp/**`（**除** `TransferService.ts`），`src/tree/Sftp*.ts`，`test/sftp/**`，`test/tree/Sftp*.ts`。
- **不拥有**：`src/extension.ts`，`src/agent/**`。
- **必须交付**：用户会话可注入 KI prompt；`close`/`error` 后 `isConnected()===false` 且 manager 重建；拖拽目录+冲突与 Upload 命令同语义；预览静默且 `preview: true`；编辑缓存目录写入忽略全部文件的 `.gitignore`。

### D — agent-mcp

- **拥有**：`src/agent/**`（**除** `SftpWriteAuthorizer.ts`），`src/mcp/**`，`skills/at-terminal-mcp/**`（**除** `references/setup.md`），`test/agent/**`（除 WriteAuthorizer 测试），`test/mcp/**`。
- **不拥有**：`src/extension.ts`，`l10n/**`。
- **必须交付**：命令超时 `signal('KILL')` + catalog 说明；SFTP connect/读超时；确认 120s / I/O 60s 拆开；`sftp_stat_path` 类型与权限；`sftp_checksum`；多服务器 exec/write 拒绝隐式目标；审计记录 trust/action/reasonCode；已存在叶节点 realpath/lstat。

### E — ux-release

- **拥有**：`src/extension.ts`，`src/webview/TerminalPanel.ts`，`src/tree/TreeItems.ts`，`src/tree/ServerTreeProvider.ts`，`package.json`，`package.base.json`，`package.mcp.json`，`package.nls*`，`.github/workflows/ci.yml`，`scripts/package-variant.mjs`，`vitest.config.ts`，`docs/usage.md`，`docs/usage.zh-CN.md`，`README.md`，`docs/README.zh-CN.md`，`test/extension/**`，`test/webview/TerminalPanel.test.ts`，`test/package.variants.test.ts`，`test/package.baseBundle.test.ts`。
- **必须交付**：树单击复用已连接面板；webview serializer（只恢复面板 + 一键重连，不自动认证）；空闲断开把输出算活动；SFTP welcome 可达；MCP 宿主诚实提示；`keepAliveInterval` 接线或删除；CI 去掉过时 sibling hub、加上打包或至少 version 对齐断言；usage/features 补齐已交付命令（与 A 的 features 表不冲突：A 改 Limited-trust 句，E 补能力列表）。

---

## 集成者清单

1. 按 A→D 的 `_wiring-*.md` 改 `extension.ts`（KI prompt 注入 SftpManager、凭据 InputBox、认证失败按钮、serializer 注册、connect 复用、idle 输出）。
2. 把各切片列出的 `t()` 英文字符串补进 `l10n/bundle.l10n.zh-cn.json`（若 A 已先合入，后续切片只追加）。
3. `npx tsc --noEmit` && `npx vitest run`。
4. 不要把本轮合进 `main`，除非维护者明确要求。
