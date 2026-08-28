# Slice A — trust-i18n 实现细则

> 实现 Agent 必须先读 `docs/handoffs/IMPLEMENTATION-PLAN.md`（操作规程与文件所有权），再按本文逐条执行。本文所有「当前代码」引用均核对自基线树 `/home/ubuntu/workspace-integrate` @ `27deea6`（分支 `cursor/implement-optimizations-11f8`）。行号可能漂移，一律以符号名与引用的字符串定位。

| 项 | 值 |
| --- | --- |
| 基线 | `origin/cursor/implement-optimizations-11f8`（`27deea6` 或其后 HEAD），**禁止** checkout/commit/push `main` |
| 工作分支 | 新建 `cursor/slice-a-trust-i18n-11f8` |
| 拥有的文件 | `src/agent/SftpWriteAuthorizer.ts`、`src/utils/commandPreview.ts`、`src/sftp/TransferService.ts`、`l10n/bundle.l10n.zh-cn.json`、`docs/features.md`、`docs/features.zh-CN.md`、`skills/at-terminal-mcp/references/setup.md`、`test/agent/SftpWriteAuthorizer.test.ts`、`test/docs/McpDocs.test.ts`、`test/docs/AtTerminalMcpSkill.test.ts`，以及上述源文件的配套测试（`test/utils/commandPreview.test.ts`、`test/sftp/TransferService.test.ts`、`test/agent/createSftpWriteAuthorizer.test.ts`） |
| 不拥有 | `src/extension.ts`、`src/agent/AgentToolService.ts`、`src/agent/SftpAgentService.ts`、`src/sftp/SftpManager.ts`、`src/sftp/SftpDragAndDropController.ts`、`src/mcp/toolCatalog.ts`、`src/webview/ServerFormPanel.ts`、`package.json`。需要动它们的补丁一律写进 `docs/handoffs/_wiring-a.md`（见「Wiring file contents」，本切片同时交付该文件） |
| 验收命令 | `npx tsc --noEmit` && `npx vitest run`（全量，基线为 717 全绿，改完必须 ≥717 且全绿） |

---

## Goal / Non-goals

**Goal（本切片必须交付，全部五项）：**

1. `src/agent/SftpWriteAuthorizer.ts` 的**写入**同意弹窗（按钮 `SCOPE_LABELS`、敏感确认按钮 `SENSITIVE_ACKNOWLEDGEMENT`、正文 `formatWritePrompt`、`formatSensitiveDoubleCheck`）全部改走 `t()`，与同文件里已本地化的删除弹窗（`formatDeletePrompt`、`formatSensitiveDeleteDoubleCheck`）完全同构。
2. `src/utils/commandPreview.ts` 的远程命令确认正文（标题句、destructive 警告、截断后缀）改走 `t()`。按钮 `Run Command` 已在 `AgentToolService.ts` 里 `t('Run Command')`，**不改 `AgentToolService.ts`**。
3. `src/sftp/TransferService.ts`：`${label} completed.` / `${label} failed.` 改为 `t('{label} completed.', …)` / `t('{label} failed.', …)`；`requireConnected` 的 throw 走 `t()`。`SftpManager.deleteEntry` 传的裸 `'delete'` label 与 `SftpDragAndDropController.ts` 里的英文 requireConnected throw 均不属于本切片文件，补丁写进 `docs/handoffs/_wiring-a.md`（本细则给出精确内容），但对应 l10n key 由本切片先行写入 bundle。
4. 修复 Limited-trust 自相矛盾：`docs/features.md` 与 `docs/features.zh-CN.md` 的工具表 `run_remote_command` 行仍写「只有 policy 证明普通只读才免确认」，与同文件 Safety 节（黑名单叙事：未知命令直接运行）矛盾。把**表格行**改成黑名单叙事，并在 `test/docs/McpDocs.test.ts` 加测试禁止旧句。
5. 和解 skill 安装命令名：`skills/at-terminal-mcp/references/setup.md` 写 `AT Terminal: Install MCP Config`，真实命令面板标题是 `AT Terminal: Install/Repair MCP Config`（`package.nls.json` 的 `atTerminal.command.installMcpConfig.title` = `Install/Repair MCP Config`，command category = `AT Terminal`）。翻转 `test/docs/AtTerminalMcpSkill.test.ts` 的钉死断言、更新 `setup.md`。**不发明第三个名字。**

**Non-goals（明确不做，详见「Out of scope」）：**

- 不实现任何新功能、不改任何授权/信任决策逻辑（`requireWrite`/`requireDelete`/`authorizeRemoteCommand` 的分支与 throw 行为一字不动）。
- 不改 `AgentToolService.ts`、`SftpAgentService.ts`、`extension.ts`、`package.json`、`package.nls*`。
- 不本地化 agent 侧（MCP 错误载荷）的取消/校验错误：`'SFTP write was cancelled.'`、`'SFTP delete was cancelled.'`、`'Remote command was cancelled.'`、`'Remote command cannot be empty.'` 保持英文。
- `authorizeRemoteCommand` 返回的 `riskSummaries`（来自 `@at-series/command-policy` 的 evidence）暂留英文，随本地化正文原样拼接（分析文档 `2026-08-27-next-improvements.md` P0-1 已写明允许）。

---

## Current behavior

以下每条给出文件、符号与今天的字符串/逻辑，实现前请先打开文件比对。

### 1. `src/agent/SftpWriteAuthorizer.ts` — 写入弹窗硬编码英文，删除弹窗已本地化

模块级常量（写入路径专用，删除路径不用它们）：

```159:165:src/agent/SftpWriteAuthorizer.ts
const SCOPE_LABELS: Record<SftpWriteScope, string> = {
  once: 'Allow Once',
  directory: 'Allow This Folder For 15 Minutes',
  session: 'Allow This Folder For The Session'
};

const SENSITIVE_ACKNOWLEDGEMENT = 'Write It Anyway, Once';
```

默认确认函数 `confirmWithVscode`（注意删除分支已经是 `t('Delete It Anyway, Once')` / `t('Delete Once')`，写入分支还在用上面两个裸常量）：

```167:189:src/agent/SftpWriteAuthorizer.ts
async function confirmWithVscode(confirmation: SftpWriteConfirmation): Promise<SftpWriteScope | undefined> {
  const isDelete = confirmation.request.operation === 'delete_file';
  if (confirmation.stage === 'sensitive-double-check') {
    const acknowledgement = isDelete ? t('Delete It Anyway, Once') : SENSITIVE_ACKNOWLEDGEMENT;
    // ... showWarningMessage(formatSensitiveDeleteDoubleCheck | formatSensitiveDoubleCheck, { modal: true }, acknowledgement)
  }
  if (isDelete) {
    const deleteOnce = t('Delete Once');
    // ... showWarningMessage(formatDeletePrompt(confirmation), { modal: true }, deleteOnce)
  }
  // The first item is the focused default, so the least-privilege answer is the one Enter picks.
  const items = confirmation.allowedScopes.map((scope) => SCOPE_LABELS[scope]);
  const answer = await vscode.window.showWarningMessage(formatWritePrompt(confirmation), { modal: true }, ...items);
  return confirmation.allowedScopes.find((scope) => SCOPE_LABELS[scope] === answer);
}
```

`formatWritePrompt(confirmation: SftpWriteConfirmation): string` 今天逐句为（模板字符串硬编码）：

- `` `WARNING: outside the working directory ${confirmation.workspaceRoot} that this session was opened in.` ``
- `'WARNING: sensitive system path (SSH keys, service units, cron, or system configuration).'`
- `` `Allow AT Terminal agent SFTP write on ${server.label} (${server.host})?` ``
- `` `Operation: ${request.operation}` ``
- `` `Path: ${request.path}` ``
- `` `Folder: ${confirmation.parentDirectory}` ``
- `` `Overwrite: ${request.overwrite ? 'yes' : 'no'}` ``
- `'Allowing a folder covers later writes to that folder only, never the whole server.'`

`formatSensitiveDoubleCheck(confirmation)` 今天逐句为：

- `` `${confirmation.request.path} is a sensitive system path on ${confirmation.server.host}.` ``
- 两个数组元素以 `'\n'` 连接成两行：`'Writing here can grant persistent access: authorized keys, sudo rules, cron entries and'` + `'service units all survive the session and run without you.'`
- `'Confirm once more to allow this single write. This answer is never remembered.'`

对照物（**不改**，作为同构模板）：`formatDeletePrompt` / `formatSensitiveDeleteDoubleCheck` 已全部走 `t()`，用的 key（bundle 里已存在，禁止重复添加）：`'Allow AT Terminal agent to delete a remote file on {label} ({host})?'`、`'Path: {path}'`、`'Folder: {folder}'`、`'WARNING: outside the working directory {root} that this session was opened in.'`、`'WARNING: sensitive system path (SSH keys, service units, cron, or system configuration).'`、`'Deleting always asks, even on fully trusted servers, and this answer is never remembered.'`、`'{path} is a sensitive system path on {host}.'`、`'Deleting here can break logins, services, or scheduled jobs on the server.'`、`'Confirm once more to allow this single delete. This answer is never remembered.'`、`'Delete Once'`、`'Delete It Anyway, Once'`。

信任门（不改）：`requireWrite` 首行 `if (shouldAutoApproveSftpWrite(server)) { return; }` —— full trust 直接返回，**不构造任何字符串**；`requireDelete` 没有这个门，删除永远弹窗。

### 2. `src/utils/commandPreview.ts` — 确认正文硬编码英文

当前完整逻辑（文件今天零依赖，无任何 import）：

```19:23:src/utils/commandPreview.ts
  if (preview !== command) {
    return `${preview}\n… (truncated, ${totalChars} chars, ${totalLines} lines)`;
  }
  return command;
}
```

```25:37:src/utils/commandPreview.ts
export function formatRemoteCommandConfirmMessage(options: {
  serverLabel: string;
  host: string;
  command: string;
  destructive: boolean;
  riskSummaries?: readonly string[];
}): string {
  const preview = truncateCommandPreview(options.command);
  const warning = options.destructive ? '\n\nWarning: this command appears destructive.' : '';
  const uniqueSummaries = [...new Set((options.riskSummaries ?? []).filter((summary) => summary.length > 0))];
  const risks = uniqueSummaries.length === 0 ? '' : `\n\n${uniqueSummaries.map((summary) => `- ${summary}`).join('\n')}`;
  return `Run remote command on ${options.serverLabel} (${options.host})?\n\n${preview}${warning}${risks}`;
}
```

唯一调用方是 `src/agent/AgentToolService.ts` 的 `runRemoteCommand`（第 72–85 行附近），按钮已是 `const runCommandLabel = t('Run Command');`，bundle 已有 `"Run Command": "运行命令"`。**因此本项无需任何 AgentToolService 改动，也不需要 WIRING 片段**——`commandPreview.ts` 自己 `import { t } from '../i18n/t'` 即可（`t.ts` 依赖 `vscode`，而 `commandPreview.ts` 只被扩展宿主内的 `AgentToolService` 引用，测试侧 `vitest.config.ts` 已把 `vscode` alias 到 `test-fixtures/vscode.ts`）。

### 3. `src/sftp/TransferService.ts` 及两处不拥有的英文残留

```31:35:src/sftp/TransferService.ts
  async requireConnected(connected: boolean): Promise<void> {
    if (!connected) {
      throw new Error('No connected SSH terminal is active.');
    }
  }
```

`runWithReporter` 内：成功 `` void this.reporter?.notifySuccess(`${label} completed.`); ``，失败（非冲突）`` void this.reporter?.notifyFailure(`${label} failed.`); ``。文件今天只 import `isSftpConflictError`。

上游 label 现状：`SftpManager`（**slice C 拥有**）的 `uploadFile`/`downloadFile`/`uploadDirectory`/`downloadDirectory`/`createFile` 已传 `t('Upload {path}')` 等本地化 label；但 `deleteEntry` 传裸 `'delete'`（quiet 模式，label 只在失败 toast `delete failed.` 出现）：

```238:251:src/sftp/SftpManager.ts
  async deleteEntry(entry: SftpEntry): Promise<void> {
    try {
      await this.runConnected(
        'delete',
        async (session) => {
          if (entry.type === 'directory') {
            await session.deleteDirectory(entry.path);
            return;
          }
          await session.deleteFile(entry.path);
        },
        undefined,
        QUIET
      );
```

另外 `src/sftp/SftpDragAndDropController.ts`（**slice C 拥有**）`handleDrop` 第 44–47 行仍抛英文原串：`throw new Error('No connected SSH terminal is active.');`（未 import `t`；同一字符串在 `SftpManager.ts`、`SftpEditSessionManager.ts` 里已经走 `t()`，bundle 已有该 key）。这两处补丁 → `_wiring-a.md`。

### 4. `docs/features.md` / `docs/features.zh-CN.md` — 工具表与 Safety 节自相矛盾

工具表（`docs/features.md` 约第 65 行，以 `| \`run_remote_command\` |` 行定位）当前中段句：

> `Every command is confirmed unless the server is trusted and `@at-series/command-policy` proves an ordinary read.`

Safety 节（同文件约第 81 行，`run_remote_command confirmation follows the server trust dropdown` 一条）已是黑名单叙事，包含：

> `Commands that miss the blocklist — including unknown commands — run without a prompt under limited trust.`

中文对应：`docs/features.zh-CN.md` 表格行（约第 65 行）当前中段句为「除非服务器已被信任且 `@at-series/command-policy` 能证明这是普通只读，否则每条命令都要确认。」；安全节（约第 77 行）已是「**不在黑名单中的命令（包括未知命令）在有限信任下不弹窗直接运行。**」。

黑名单叙事同时也是**产品内代码文案**的叙事（三处互相一致，均不属于本切片）：`src/mcp/toolCatalog.ts` 的 `run_remote_command.description`（含 `Unknown commands are not on the blocklist and run without a prompt on a limited-trust or fully trusted server.`）、`src/webview/ServerFormPanel.ts` 的 `trustHelp` 三行帮助（`'State-changing commands on the blocklist … Commands not on the blocklist, including unknown commands, run without asking. …'`，bundle 已有 zh 翻译）、以及钉死它们的 `test/mcp/toolCatalog.test.ts`（`it('admits to the caller that an unknown command is not gated')`）与 `test/webview/ServerFormMarkup.test.ts`。`docs/handoffs/IMPLEMENTATION-CONTRACT.md` 第 74 行明确要求「Fix `docs/features*.md` to match code, not the reverse」。

> **事实核查备注（实测 27deea6，实现者必须知悉但不得据此扩大改动）**：`src/agent/remoteCommandAuthorization.ts` 只在 `decision.action === 'allow'` 时 `autoApprove`；实际执行 `dist/policy-runtime.js`（即 `@at-series/command-policy@0.1.0` 的 `createShellPolicyEvaluator`）对未知命令返回 `review`——实测 `frobnicate --baz` / `terraform plan` / `mycustomtool status` 均得 `{ action: 'review', reasonCode: 'shell.unknown_semantics' }`，即**运行时对未知命令仍会弹确认**，比黑名单叙事更严格。本切片的合同任务是消除 features 文档内部矛盾并与产品内文案（toolCatalog / trustHelp / Safety 节）对齐；文档声称「弹得比实际少」是安全方向的误差（用户只会更谨慎）。「代码文案 vs 运行时」的最终对齐属于 slice D（`toolCatalog.ts`）/ 产品决策，本切片**禁止**改 `toolCatalog.ts`、`ServerFormPanel.ts` 或 policy 依赖，只需把本备注抄进 `_wiring-a.md` 的 NOTE 供集成者上报。

### 5. skill 安装命令名 — 两套 drift 测试互斥

- `skills/at-terminal-mcp/references/setup.md` 第 9 行与第 14 行写 `` `AT Terminal: Install MCP Config` ``（陈旧名）。
- 真实名：`package.json` contributes `sshManager.installMcpConfig`，`category: "AT Terminal"`，`title: %atTerminal.command.installMcpConfig.title%`；`package.nls.json` 解析为 `Install/Repair MCP Config`（zh：`安装/修复 MCP 配置`）。命令面板显示 `AT Terminal: Install/Repair MCP Config`，`docs/usage.md` / `docs/usage.zh-CN.md` 已用此名。
- `test/docs/AtTerminalMcpSkill.test.ts` 第 74 行钉死陈旧名：`expect(setup).toContain('AT Terminal: Install MCP Config');`
- `test/docs/McpDocs.test.ts` 第 34–35、48–49 行对 usage 文档要求 `toContain('AT Terminal: Install/Repair MCP Config')` 且 `not.toContain('AT Terminal: Install MCP Config')`。两套测试对不同文件断言相反的名字，skill 与产品文档说法互斥。

### 通用机制（改动前必须理解）

- `src/i18n/t.ts`：`export function t(message: string, args?: TranslationArgs): string`，`TranslationArgs = Record<string, string | number | boolean>`（**不允许 undefined**）。转发给 `vscode.l10n.t`；无翻译时 `vscode.l10n.t` 回退返回英文原文并替换占位符。
- `test/i18n/nls.test.ts` 的 drift 测试用正则 `/(?<![\w.])t\(\s*'((?:[^'\\]|\\.)*)'/gs` 扫 `src/**/*.ts` 里**单引号字面量**形式的 `t('…')` 调用，要求每个 key 都在 `l10n/bundle.l10n.zh-cn.json` 出现，否则测试失败。因此：新 `t()` 调用第一个参数**必须是单引号字符串字面量**（禁止变量、模板字符串、拼接）；每加一个新 key 必须同步写 bundle。同文件另一测试要求 zh 译文的 `{placeholder}` 集合与英文 key 完全一致。bundle 不检查排序、不检查未使用的 key（所以可为 wiring 预置 key）。
- 测试夹具 `test-fixtures/vscode.ts` 的 `l10n.t` 是恒等实现：返回英文原文并做 `{placeholder}` 替换。所以现有断言英文字符串的测试在本地化后**输出不变、必须继续全绿**（例如 `test/sftp/TransferService.test.ts` 的 `'Upload docker-compose.yml completed.'`、`test/agent/createSftpWriteAuthorizer.test.ts` 的 `'Allow Once'` 按钮、`test/agent/AgentToolService.test.ts` 第 539 行的 `'Warning: this command appears destructive.'`、`test/utils/commandPreview.test.ts` 的截断后缀）。若这些测试变红，说明你改错了英文源串——**英文 key 必须逐字符等于今天的输出**（唯一例外见下文 `formatSensitiveDoubleCheck` 的两行合并）。

---

## Target behavior

用户可见变化（`vscode.env.language = zh-cn` 时）：

1. Agent 发起 SFTP 写入时，弹窗正文与三个按钮全为中文，例如按钮「仅允许一次 / 允许此目录 15 分钟 / 本会话内允许此目录」，敏感二次确认按钮「仍然写入一次」；路径、目录、`operation` 值（`write_file` 等标识符）保持原样嵌入。删除弹窗行为与文案不变（已本地化）。
2. Agent 发起远程命令时，确认框标题「是否在 {label}（{host}）上运行远程命令？」、destructive 警告「警告：此命令看起来具有破坏性。」、长命令截断后缀「…（已截断，共 {chars} 字符、{lines} 行）」均为中文；命令原文与 `riskSummaries`（英文，来自 policy）原样保留；按钮已是「运行命令」。
3. SFTP 传输成功/失败 toast 为「上传 /path 已完成。」/「上传 /path 失败。」（label 本身已由 `SftpManager` 本地化，`TransferService` 负责句式）；未连接时的错误为「没有活动的已连接 SSH 终端。」。wiring 合入后，删除失败 toast 为「删除 /path 失败。」，拖拽上传在未连接时也抛中文错误。
4. 英文/中文 features 文档中 `run_remote_command` 表格行与 Safety 节叙事一致（黑名单：命中才弹，未知命令直接运行，解析不了必弹，full trust 从不弹），且有测试禁止旧句回归。
5. skill 的 `setup.md` 与产品命令面板、usage 文档统一用 `AT Terminal: Install/Repair MCP Config`；两套 drift 测试不再互斥。

英文 locale 下唯一可感知变化：敏感写入二次确认正文第二段由两行合并为一行（见下），其余输出逐字符不变。

---

## File-by-file edits

除下列文件外不得改动任何文件。每处给出 before/after；「合同」指改动后必须保持的类型与行为。

### A1. `src/agent/SftpWriteAuthorizer.ts`

**合同**：所有导出符号（`SftpWriteScope`、`SftpWriteRequest`、`SftpWriteConfirmation`、`ConfirmSftpWrite`、`DIRECTORY_GRANT_TTL_MS`、`SftpWriteAuthorizerOptions`、`SftpWriteAuthorizer`）的签名与行为一字不动；`requireWrite`/`requireDelete` 的授权逻辑、grant 语义、throw 消息（`'SFTP write was cancelled.'` / `'SFTP delete was cancelled.'`，保持英文）不变。只动模块私有的 `SCOPE_LABELS`、`SENSITIVE_ACKNOWLEDGEMENT`、`confirmWithVscode`、`formatWritePrompt`、`formatSensitiveDoubleCheck`。`formatDeletePrompt`、`formatSensitiveDeleteDoubleCheck`、`resolveAllowedScopes` 不动。文件已 `import { t } from '../i18n/t';`，无需新 import。

(a) **删除**模块级常量 `SCOPE_LABELS` 与 `SENSITIVE_ACKNOWLEDGEMENT`（第 159–165 行），替换为一个私有函数（不导出；不得在模块顶层调用 `t()`，label 必须在弹窗时求值，与删除分支的内联 `t('Delete Once')` 模式一致）：

```ts
function scopeLabel(scope: SftpWriteScope): string {
  if (scope === 'directory') {
    return t('Allow This Folder For 15 Minutes');
  }
  if (scope === 'session') {
    return t('Allow This Folder For The Session');
  }
  return t('Allow Once');
}
```

(b) `confirmWithVscode` 三处替换：

```ts
// before
const acknowledgement = isDelete ? t('Delete It Anyway, Once') : SENSITIVE_ACKNOWLEDGEMENT;
// after
const acknowledgement = isDelete ? t('Delete It Anyway, Once') : t('Write It Anyway, Once');
```

```ts
// before
const items = confirmation.allowedScopes.map((scope) => SCOPE_LABELS[scope]);
// after
const items = confirmation.allowedScopes.map((scope) => scopeLabel(scope));
```

```ts
// before
return confirmation.allowedScopes.find((scope) => SCOPE_LABELS[scope] === answer);
// after
return confirmation.allowedScopes.find((scope) => scopeLabel(scope) === answer);
```

保留 `// The first item is the focused default…` 注释与「首个按钮为最小授权默认项」的顺序语义。

(c) `formatWritePrompt` 整函数替换为（与 `formatDeletePrompt` 同构；`Path:`/`Folder:`/两条 WARNING 复用**已存在**的 bundle key，禁止另造新 key）：

```ts
function formatWritePrompt(confirmation: SftpWriteConfirmation): string {
  const { server, request } = confirmation;
  const warnings = [
    confirmation.outsideWorkspace
      ? t('WARNING: outside the working directory {root} that this session was opened in.', {
          root: confirmation.workspaceRoot
        })
      : undefined,
    confirmation.sensitive
      ? t('WARNING: sensitive system path (SSH keys, service units, cron, or system configuration).')
      : undefined
  ].filter((warning): warning is string => warning !== undefined);

  return [
    t('Allow AT Terminal agent SFTP write on {label} ({host})?', {
      label: server.label,
      host: server.host
    }),
    '',
    t('Operation: {operation}', { operation: request.operation }),
    t('Path: {path}', { path: request.path }),
    t('Folder: {folder}', { folder: confirmation.parentDirectory }),
    request.overwrite ? t('Overwrite: yes') : t('Overwrite: no'),
    ...(warnings.length > 0 ? ['', ...warnings] : []),
    '',
    t('Allowing a folder covers later writes to that folder only, never the whole server.')
  ].join('\n');
}
```

注意：`Overwrite` 用两条整句 key（`'Overwrite: yes'` / `'Overwrite: no'`），**不要**做 `t('Overwrite: {answer}', { answer: t('yes') })` 之类的碎片拼接——孤立翻译 yes/no 在中文里语法不成立，且恒等夹具下整句 key 才能保证英文输出逐字符不变。`operation` 的取值（`write_file` 等）是标识符，原样代入占位符，不翻译。

(d) `formatSensitiveDoubleCheck` 整函数替换为（与 `formatSensitiveDeleteDoubleCheck` 同构；**唯一的英文渲染变化**：原第二段的两个数组元素合并为一条 key，行间的 `\n` 变为空格——模态框自动折行，删除路径的对应句就是单 key 单行，属有意对齐）：

```ts
function formatSensitiveDoubleCheck(confirmation: SftpWriteConfirmation): string {
  return [
    t('{path} is a sensitive system path on {host}.', {
      path: confirmation.request.path,
      host: confirmation.server.host
    }),
    '',
    t('Writing here can grant persistent access: authorized keys, sudo rules, cron entries and service units all survive the session and run without you.'),
    '',
    t('Confirm once more to allow this single write. This answer is never remembered.')
  ].join('\n');
}
```

### A2. `src/utils/commandPreview.ts`

**合同**：`COMMAND_PREVIEW_MAX_LINES`、`COMMAND_PREVIEW_MAX_CHARS`、`truncateCommandPreview(command, maxLines?, maxChars?)`、`formatRemoteCommandConfirmMessage(options)` 的导出签名不变；截断阈值逻辑、riskSummaries 去重/过滤/`- ` 前缀拼接逻辑不变；恒等夹具下英文输出逐字符不变。

(a) 文件头新增 `import { t } from '../i18n/t';`（该文件从此依赖 `vscode`；已确认唯一生产调用方 `AgentToolService.ts` 在扩展宿主内，测试经 alias 走夹具，无其他消费者）。

(b) 截断后缀：

```ts
// before
return `${preview}\n… (truncated, ${totalChars} chars, ${totalLines} lines)`;
// after
return `${preview}\n${t('… (truncated, {chars} chars, {lines} lines)', { chars: totalChars, lines: totalLines })}`;
```

省略号是单字符 `…`（U+2026），照抄，不要写成三个点。

(c) 确认正文：

```ts
// before
const warning = options.destructive ? '\n\nWarning: this command appears destructive.' : '';
// after
const warning = options.destructive ? `\n\n${t('Warning: this command appears destructive.')}` : '';
```

```ts
// before
return `Run remote command on ${options.serverLabel} (${options.host})?\n\n${preview}${warning}${risks}`;
// after
return `${t('Run remote command on {label} ({host})?', {
  label: options.serverLabel,
  host: options.host
})}\n\n${preview}${warning}${risks}`;
```

`\n\n` 分隔符留在 `t()` 之外（key 里不含换行）。`risks` 列表内容（policy evidence 摘要）保持英文原样。**不改 `AgentToolService.ts`**：按钮与调用点今天已正确，无需 WIRING 片段。

### A3. `src/sftp/TransferService.ts`

**合同**：`TransferProgress`、`TransferJob`、`TransferReporter`、`TransferRunOptions`、`TransferService` 的导出签名不变；quiet/full 语义、冲突不 toast 的行为、通知不阻塞返回的行为不变。

(a) 文件头新增 `import { t } from '../i18n/t';`。

(b) 三处字符串：

```ts
// before
throw new Error('No connected SSH terminal is active.');
// after（key 已在 bundle 中，勿重复添加）
throw new Error(t('No connected SSH terminal is active.'));
```

```ts
// before
void this.reporter?.notifySuccess(`${label} completed.`);
// after
void this.reporter?.notifySuccess(t('{label} completed.', { label }));
```

```ts
// before
void this.reporter?.notifyFailure(`${label} failed.`);
// after
void this.reporter?.notifyFailure(t('{label} failed.', { label }));
```

`label` 由调用方传入，可能已是中文（`SftpManager` 传 `t('Upload {path}')` 等）；`vscode.l10n.t` 只做一次占位符替换、不递归解析，嵌套安全。

### A4. `l10n/bundle.l10n.zh-cn.json`

按下文「l10n keys table」新增 17 个条目（其中 `'Delete {path}'` 为 wiring 预置）。要求：JSON 合法、key 唯一（每个新 key 在文件中恰好出现一次）、zh 值的 `{placeholder}` 集合与英文 key 完全一致；建议按现有字典序插入（无测试强制排序）。**禁止**添加表中标注「已存在」的 key，**禁止**改动任何现有条目。

### A5. `docs/features.md`

只改工具表 `run_remote_command` 一行（以 `| \`run_remote_command\` | command |` 定位）。整行替换为（首尾的 tool/type 单元与 stdout/stderr 尾句保持不变，只换中段确认句）：

```markdown
| `run_remote_command` | command | Runs a confirmed non-interactive SSH command and returns stdout, stderr, exit code, timeout, duration, and truncation metadata. Confirmation follows the server trust level: untrusted always asks; limited trust checks every stage against a blocklist of state-changing programs, and commands that miss the blocklist — including unknown commands — run without a prompt; commands that cannot be read plainly always ask; full trust never asks. stdout/stderr each default to 64000 bytes (hard cap 256000). |
```

Safety 节（第 81 行附近那条长句）**不动**——它已是黑名单叙事。第 77 行 Safety 节里的按钮名 `` `Allow Once` `` 等以英文源串形式列出，本地化后英文源串仍是 l10n key，**不改文档**。

### A6. `docs/features.zh-CN.md`

同样只改表格 `run_remote_command` 一行（以 `| \`run_remote_command\` | 命令 |` 定位），整行替换为：

```markdown
| `run_remote_command` | 命令 | 执行经过确认的非交互 SSH 命令，并返回 stdout、stderr、exit code、timeout、duration 和截断信息。是否确认跟随服务器信任级别：不信任总是确认；有限信任对命令的每一段检查变更状态黑名单，不在黑名单中的命令（包括未知命令）不弹窗直接运行，无法安全解析的命令总是确认；完全信任从不确认。stdout/stderr 各默认 64000 字节（硬顶 256000）。 |
```

安全节（第 77 行附近）**不动**。

### A7. `skills/at-terminal-mcp/references/setup.md`

把两处 `` `AT Terminal: Install MCP Config` `` 逐字替换为 `` `AT Terminal: Install/Repair MCP Config` ``，其余内容不动：

- 第 9 行：`- Prefer the command-palette action \`AT Terminal: Install/Repair MCP Config\` for Kiro, Cursor, and Continue. It writes an **AT Series** MCP entry that points at \`~/.at-series/mcp/hub.js\`.`
- 第 14 行：`2. Run \`AT Terminal: Install/Repair MCP Config\`, or manually add an MCP server named \`AT Series\` that runs \`node\` against \`~/.at-series/mcp/hub.js\`.`

不发明第三个名字；不改 `package.nls*`（已正确）；不动 `SKILL.md` 与其他 references。

### A8. `docs/handoffs/_wiring-a.md`（新文件）

内容见「Wiring file contents」一节，逐字创建。

---

## Tests to add/change

全部测试跑在恒等 l10n 夹具下（`test-fixtures/vscode.ts` 的 `l10n.t` 返回英文原文并替换占位符），因此断言写英文替换后的结果。

### T1. `test/agent/SftpWriteAuthorizer.test.ts` — 新增 describe

现有全部用例（注入 confirm 的授权逻辑测试）**不改一字、必须保持绿**。文件顶部 import 改为 `import { afterEach, describe, expect, it, vi } from 'vitest';` 并新增 `import * as vscode from 'vscode';`。文件末尾追加：

```ts
describe('SftpWriteAuthorizer default confirm localization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes the write prompt body and scope buttons through t()', async () => {
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const authorizer = new SftpWriteAuthorizer();

    await expect(
      authorizer.requireWrite(server(), write(`${WORKSPACE_ROOT}/notes/a.txt`))
    ).rejects.toThrow('SFTP write was cancelled.');

    const message = vi.mocked(showWarningMessage).mock.calls[0][0] as string;
    expect(message).toContain('Allow AT Terminal agent SFTP write on Production (prod.example.com)?');
    expect(message).toContain('Operation: write_file');
    expect(message).toContain(`Path: ${WORKSPACE_ROOT}/notes/a.txt`);
    expect(message).toContain(`Folder: ${WORKSPACE_ROOT}/notes`);
    expect(message).toContain('Overwrite: no');
    expect(message).toContain('Allowing a folder covers later writes to that folder only, never the whole server.');
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.any(String),
      { modal: true },
      'Allow Once',
      'Allow This Folder For 15 Minutes',
      'Allow This Folder For The Session'
    );
  });

  it('routes the sensitive double-check body and acknowledgement through t()', async () => {
    const showWarningMessage = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValueOnce('Allow Once' as never)
      .mockResolvedValueOnce('Write It Anyway, Once' as never);
    const authorizer = new SftpWriteAuthorizer();

    await authorizer.requireWrite(server(), write('/etc/cron.d/backup', { overwrite: true }));

    expect(showWarningMessage).toHaveBeenCalledTimes(2);
    const primary = vi.mocked(showWarningMessage).mock.calls[0][0] as string;
    const doubleCheck = vi.mocked(showWarningMessage).mock.calls[1][0] as string;
    expect(primary).toContain('Overwrite: yes');
    expect(doubleCheck).toContain('/etc/cron.d/backup is a sensitive system path on prod.example.com.');
    expect(doubleCheck).toContain(
      'Writing here can grant persistent access: authorized keys, sudo rules, cron entries and service units all survive the session and run without you.'
    );
    expect(doubleCheck).toContain('Confirm once more to allow this single write. This answer is never remembered.');
    expect(vi.mocked(showWarningMessage).mock.calls[1]).toContain('Write It Anyway, Once');
  });
});
```

说明：`server()`、`write()`、`WORKSPACE_ROOT` 是该文件既有 helper；`new SftpWriteAuthorizer()` 无注入即走 `confirmWithVscode`。`/etc/cron.d/backup` 为敏感路径，首弹只有 `Allow Once` 一个按钮、二弹按钮为 `Write It Anyway, Once`（第二用例的第二个 `mock.calls[1]` 数组包含断言即验证按钮）。

`test/agent/createSftpWriteAuthorizer.test.ts` **不改**：其现有断言（三个英文按钮、`WARNING:` 前缀、`'Write It Anyway, Once'`）就是本地化改造的回归护栏，改完必须原样通过。

### T2. `test/utils/commandPreview.test.ts` — 追加 1 个用例

现有 5 个用例不动（截断后缀与 destructive 警告在恒等夹具下输出不变）。追加：

```ts
  it('renders the localized header before the command preview', () => {
    const message = formatRemoteCommandConfirmMessage({
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command: 'uptime',
      destructive: false
    });
    expect(message).toBe('Run remote command on Production (server-1.example.com)?\n\nuptime');
  });
```

### T3. `test/sftp/TransferService.test.ts` — 不改

现有断言（`'Upload docker-compose.yml completed.'`、`'delete failed.'`、`'No connected SSH terminal is active.'`）即回归护栏，必须原样通过。

### T4. `test/docs/McpDocs.test.ts` — 新增 it，禁止旧句

在 `describe('MCP documentation')` 内追加：

```ts
  it('keeps the run_remote_command tool table on the blocklist narrative', () => {
    const features = readFileSync('docs/features.md', 'utf8');
    const chineseFeatures = readFileSync('docs/features.zh-CN.md', 'utf8');

    expect(features).not.toContain('proves an ordinary read');
    expect(features).toContain('Confirmation follows the server trust level');
    expect(features).toContain('including unknown commands');
    expect(chineseFeatures).not.toContain('能证明这是普通只读');
    expect(chineseFeatures).toContain('是否确认跟随服务器信任级别');
  });
```

说明：`'Confirmation follows the server trust level'` / `'是否确认跟随服务器信任级别'` 只出现在新表格行，钉住表格；`not.toContain` 禁止旧句回归。禁止句只针对这两个 features 文件——`docs/releases/0.3.4.md`、`docs/plans/2026-08-25-*.md` 是历史记录，**不读、不改**。

### T5. `test/docs/AtTerminalMcpSkill.test.ts` — 翻转钉死断言

在 `it('keeps setup details out of the common path')` 内，把：

```ts
    expect(setup).toContain('AT Terminal: Install MCP Config');
```

替换为（注意 `AT Terminal: Install/Repair MCP Config` 不含子串 `AT Terminal: Install MCP Config`，两条断言可共存）：

```ts
    expect(setup).toContain('AT Terminal: Install/Repair MCP Config');
    expect(setup).not.toContain('AT Terminal: Install MCP Config');
```

该 it 其余断言（`.at-series/mcp/hub.js`、配置路径等）不动。

### T6. `test/i18n/nls.test.ts` — 不改文件，但它是本切片的隐式验收

`'every string the extension translates at runtime' > 'has a zh-cn translation for every one'` 会自动扫到本切片全部新 `t('…')` 字面量；bundle 少一个 key 即红。占位符一致性同理。

---

## l10n keys table

新增 17 条（English source key → 建议 zh-CN 值）。「用于」列指向引入该 key 的符号；标注 *wiring* 的 key 由本切片预置、由集成者的补丁消费（bundle 不检查未使用 key，预置安全）。

| # | English source（bundle key，逐字符） | 建议 zh-CN | 用于 |
| --- | --- | --- | --- |
| 1 | `Allow Once` | `仅允许一次` | `scopeLabel` |
| 2 | `Allow This Folder For 15 Minutes` | `允许此目录 15 分钟` | `scopeLabel` |
| 3 | `Allow This Folder For The Session` | `本会话内允许此目录` | `scopeLabel` |
| 4 | `Write It Anyway, Once` | `仍然写入一次` | `confirmWithVscode` |
| 5 | `Allow AT Terminal agent SFTP write on {label} ({host})?` | `允许 AT Terminal Agent 在 {label}（{host}）上执行 SFTP 写入？` | `formatWritePrompt` |
| 6 | `Operation: {operation}` | `操作：{operation}` | `formatWritePrompt` |
| 7 | `Overwrite: yes` | `覆盖：是` | `formatWritePrompt` |
| 8 | `Overwrite: no` | `覆盖：否` | `formatWritePrompt` |
| 9 | `Allowing a folder covers later writes to that folder only, never the whole server.` | `允许一个目录只覆盖之后写入该目录的操作，绝不会覆盖整台服务器。` | `formatWritePrompt` |
| 10 | `Writing here can grant persistent access: authorized keys, sudo rules, cron entries and service units all survive the session and run without you.` | `在此处写入可能授予持久访问权限：authorized keys、sudo 规则、cron 条目和服务单元都会在会话结束后继续存在，并在你不在场时运行。` | `formatSensitiveDoubleCheck` |
| 11 | `Confirm once more to allow this single write. This answer is never remembered.` | `请再次确认以允许这次写入。此次选择不会被记住。` | `formatSensitiveDoubleCheck` |
| 12 | `Run remote command on {label} ({host})?` | `是否在 {label}（{host}）上运行远程命令？` | `formatRemoteCommandConfirmMessage` |
| 13 | `Warning: this command appears destructive.` | `警告：此命令看起来具有破坏性。` | `formatRemoteCommandConfirmMessage` |
| 14 | `… (truncated, {chars} chars, {lines} lines)` | `…（已截断，共 {chars} 字符、{lines} 行）` | `truncateCommandPreview` |
| 15 | `{label} completed.` | `{label} 已完成。` | `TransferService` |
| 16 | `{label} failed.` | `{label} 失败。` | `TransferService` |
| 17 | `Delete {path}` | `删除 {path}` | *wiring*：`SftpManager.deleteEntry` |

**复用而非新增**（这些 key 已在 bundle 中，代码里直接 `t()` 引用即可，重复添加会造成 JSON 重键）：`Path: {path}`、`Folder: {folder}`、`WARNING: outside the working directory {root} that this session was opened in.`、`WARNING: sensitive system path (SSH keys, service units, cron, or system configuration).`、`{path} is a sensitive system path on {host}.`、`No connected SSH terminal is active.`、`Delete Once`、`Delete It Anyway, Once`、`Run Command`。

翻译风格对齐依据：`Delete It Anyway, Once` → `仍然删除一次`（故 #4 用「仍然写入一次」）；`Confirm once more to allow this single delete…` → `请再次确认以允许这次删除。此次选择不会被记住。`（故 #11 同式）；`docs/features.zh-CN.md` 安全节称 session 档为「本会话」（故 #3）。若实现者想微调中文措辞可以，但**英文 key 一个字符都不能偏离本表**（含 `…` U+2026、逗号、句点、大小写），且占位符名不得改。

---

## Wiring file contents（`docs/handoffs/_wiring-a.md`）

本切片在仓库内创建 `docs/handoffs/_wiring-a.md`，内容逐字如下（two 处补丁属 slice C 拥有的文件，由集成者应用；对应 l10n key 已由本切片预置）：

````markdown
# Wiring — slice A (trust-i18n)

Everything below touches files slice A does not own (`src/sftp/SftpManager.ts`,
`src/sftp/SftpDragAndDropController.ts` — both belong to slice C). The integrator applies
these when merging into the integration branch. The l10n keys they need
(`"Delete {path}"`, `"No connected SSH terminal is active."`) are already present in
`l10n/bundle.l10n.zh-cn.json` after slice A, so no bundle edit is required here.

## 1. `src/sftp/SftpManager.ts` — localize the `deleteEntry` transfer label

The file already imports `t` from `../i18n/t`. In `deleteEntry`, replace the raw label:

```ts
// before
      await this.runConnected(
        'delete',
// after
      await this.runConnected(
        t('Delete {path}', { path: entry.path }),
```

`deleteEntry` runs QUIET, so the label only surfaces in the failure toast, which becomes
`t('{label} failed.')` → zh-CN「删除 /path 失败。」. No test pins the `'delete'` label
(`test/sftp/SftpManager.test.ts` never asserts it), so this is drop-in safe.

## 2. `src/sftp/SftpDragAndDropController.ts` — localize the requireConnected throw

```ts
import { t } from '../i18n/t';
// ...
    if (state.kind !== 'active') {
      throw new Error(t('No connected SSH terminal is active.'));
    }
```

(Add the import at the top of the file; the string key already exists in the bundle and is
the exact message `SftpManager` / `SftpEditSessionManager` already localize.)

## Notes for the integrator

- Remaining English labels `'new folder'` (`SftpManager.mkdir`) and `'rename'`
  (`SftpManager.rename`) also surface via `{label} failed.`; they belong to slice C and are
  intentionally not patched here.
- Fact-check escalation: at `27deea6` the bundled policy runtime
  (`@at-series/command-policy@0.1.0` via `dist/policy-runtime.js`) returns
  `{ action: 'review', reasonCode: 'shell.unknown_semantics' }` for unknown commands, i.e.
  the runtime still prompts for them, while the shipped copy (`src/mcp/toolCatalog.ts`
  description, `ServerFormPanel.ts` trust help, `docs/features*.md` Safety section, and —
  after slice A — the tool table) states the blocklist narrative ("unknown commands run
  without a prompt"). Docs erring toward "fewer prompts than reality" is the safe
  direction, but copy-vs-runtime reconciliation should be decided with slice D (which owns
  `toolCatalog.ts`) or as a product call. Slice A deliberately did not touch runtime or
  copy outside its owned files.
````

---

## Acceptance checklist

实现者完成后逐项打勾（命令均在仓库根执行）：

- [ ] 分支自 `origin/cursor/implement-optimizations-11f8` 拉出，名为 `cursor/slice-a-trust-i18n-11f8`；全程未 checkout/commit/push `main`
- [ ] 改动文件集合恰为：`src/agent/SftpWriteAuthorizer.ts`、`src/utils/commandPreview.ts`、`src/sftp/TransferService.ts`、`l10n/bundle.l10n.zh-cn.json`、`docs/features.md`、`docs/features.zh-CN.md`、`skills/at-terminal-mcp/references/setup.md`、`test/agent/SftpWriteAuthorizer.test.ts`、`test/utils/commandPreview.test.ts`、`test/docs/McpDocs.test.ts`、`test/docs/AtTerminalMcpSkill.test.ts`、新文件 `docs/handoffs/_wiring-a.md`（`git status` 无其他条目）
- [ ] `rg -n "SCOPE_LABELS|SENSITIVE_ACKNOWLEDGEMENT" src/` 无输出
- [ ] `rg -n "proves an ordinary read" docs/features.md docs/features.zh-CN.md` 无输出；`rg -n "能证明这是普通只读" docs/features.zh-CN.md` 无输出
- [ ] `rg -nF "AT Terminal: Install MCP Config" skills/ docs/` 无输出（`Install/Repair` 不构成命中）
- [ ] `rg -n "completed\.\`|failed\.\`" src/sftp/TransferService.ts` 无输出（模板字符串句式已消除）
- [ ] bundle 新增 17 个 key、无重复键：对表中每个 key 执行 `rg -cF '"<key>"' l10n/bundle.l10n.zh-cn.json` 均为 1；`node -e "JSON.parse(require('fs').readFileSync('l10n/bundle.l10n.zh-cn.json','utf8'))"` 不报错
- [ ] `npx vitest run test/agent/SftpWriteAuthorizer.test.ts test/agent/createSftpWriteAuthorizer.test.ts test/utils/commandPreview.test.ts test/sftp/TransferService.test.ts test/docs/McpDocs.test.ts test/docs/AtTerminalMcpSkill.test.ts test/i18n/nls.test.ts` 全绿
- [ ] `npx tsc --noEmit` 干净
- [ ] `npx vitest run` 全量绿，用例数 ≥ 基线 717 + 本切片新增 3（T1 两个 + T2 一个 + T4 一个 = 新增 4，若按 it 计数则 ≥721）
- [ ] `sftp_delete` 语义未被触碰：只删文件、始终确认、不进 directory grant、full trust 不免确认（现有测试即护栏，无一变红）
- [ ] 三条 agent 侧英文错误未被翻译：`rg -n "t\('SFTP write was cancelled" src/` 无输出（同理 delete/remote command cancelled）
- [ ] `docs/handoffs/_wiring-a.md` 与本细则「Wiring file contents」逐字一致
- [ ] 提交并 push：每个逻辑改动一个 commit（建议顺序：1. 写入弹窗 i18n + 测试；2. commandPreview i18n + 测试；3. TransferService i18n + bundle 全量 key；4. features 表 + McpDocs 测试；5. setup.md + skill 测试翻转；6. `_wiring-a.md`），`git push -u origin cursor/slice-a-trust-i18n-11f8`

---

## Edge cases

- **取消路径不本地化**：用户在任一弹窗点「取消/Esc」时，`requireWrite`/`requireDelete` 抛 `'SFTP write was cancelled.'` / `'SFTP delete was cancelled.'`，`AgentToolService.runRemoteCommand` 抛 `'Remote command was cancelled.'`——这些消息经 MCP 返回给 AI agent 而非人类 UI，且被现有测试逐字钉死，**保持英文**。改动后取消行为（哪一步取消、grant 是否写入）必须与今天完全一致。
- **l10n 回退**：`vscode.l10n.t` 找不到译文时返回英文原文并替换占位符——漏加 bundle key 不会渲染成花括号乱码，但会被 `test/i18n/nls.test.ts` 挡在 CI。永远不要把 key 写成变量或模板字符串（drift 正则只识别单引号字面量）。
- **full trust 跳过写入弹窗仍「无英文」**：`requireWrite` 在 `shouldAutoApproveSftpWrite(server)` 为真时 return，早于任何字符串构造——该路径零文案，天然满足「full-trust skip write prompt still English-free」。删除路径没有此门，弹的是已本地化的删除文案。现有测试 `SftpWriteAuthorizer full trust` describe 已覆盖，勿改。
- **敏感二次确认的英文渲染变化**：`formatSensitiveDoubleCheck` 第二段由两行并作一行（见 A1(d)），是唯一的英文可见 diff；无测试钉住旧的两行形态，模态框自动折行。不要为保留换行把一句话拆成两个 key。
- **`{label}` 嵌套**：`t('{label} completed.', { label })` 的 `label` 可能本身是 `t('Upload {path}')` 的结果（已含路径/中文）；`vscode.l10n.t` 只做一次替换、不递归，即便 label 内含花括号路径也不会二次展开。
- **`TranslationArgs` 禁 undefined**：所有占位参数（`operation`、`root`、`chars` 等）在调用点均为必然存在的 string/number；不要引入可选链产生 `undefined` 参数（类型层会拒绝，别用 `as` 绕过）。
- **模块加载期不得调 `t()`**：这就是 `SCOPE_LABELS` 常量必须变成 `scopeLabel()` 函数的原因——label 在弹窗时求值，与仓库既有模式（内联 `t('Delete Once')`）一致。
- **恒等夹具的语义**：测试里 `t()` 输出 = 英文 key 替换占位符。所以「本地化改造」在测试可见面上的正确性 = 现有英文断言全部不变 + 新增断言命中新 key 的英文形态。任何现有断言变红都意味着英文源串被改坏。
- **`…` 与标点**：截断 key 的 `…` 是 U+2026 单字符；`Overwrite: yes` 冒号后单空格；features 新行内的 ` — ` 是空格+em dash+空格。逐字符照抄本细则。
- **文档禁句测试的边界**：`not.toContain('proves an ordinary read')` 只施加于 `docs/features.md`（T4 只读两个 features 文件）；`docs/releases/`、`docs/plans/` 的历史出现不受影响，勿顺手清理。
- **`Install/Repair` 子串关系**：`'AT Terminal: Install/Repair MCP Config'` 不包含 `'AT Terminal: Install MCP Config'`（`Install` 后一个是 `/` 一个是空格），所以 `toContain` 新名 + `not.toContain` 旧名可同文件共存，这正是 usage 文档在 `McpDocs.test.ts` 里的既有写法。

---

## Out of scope

以下各项即使顺手可改也**禁止**在本切片动（违反文件所有权或产品边界）：

- `src/agent/AgentToolService.ts`（含 `withTimeout` 超时文案、`'Remote command cannot be empty.'`）、`src/agent/SftpAgentService.ts`、`src/extension.ts`、`package.json` / `package.base.json` / `package.mcp.json` / `package.nls*`——A 明确不拥有。
- `src/sftp/SftpManager.ts` 与 `src/sftp/SftpDragAndDropController.ts` 的实际代码改动（slice C 拥有）——只交付 `_wiring-a.md` 补丁文本；`SftpManager.mkdir` 的 `'new folder'`、`rename` 的 `'rename'` 裸 label 留给 slice C。
- `src/mcp/toolCatalog.ts` 描述、`src/webview/ServerFormPanel.ts` 的 trustHelp 三行文案、`@at-series/command-policy` 依赖或 `src/policy-runtime/**`——「代码文案 vs 运行时」的对齐（见 Current behavior #4 的事实核查备注）由集成者/slice D/产品决策处理，本切片只在 `_wiring-a.md` 留 NOTE。
- MCP 错误载荷（throw 消息）的本地化；`riskSummaries` 的翻译。
- `docs/usage.md` / `docs/usage.zh-CN.md` / `README*` 的能力清单补齐（slice E）；features 文档中除 `run_remote_command` 表格行以外的任何句子。
- 传输可取消、进度文案改版、`VscodeTransferReporter` 的任何改动。
- 新增/重命名任何命令、任何 `package.nls` key；不发明 `Install MCP Config` / `Install/Repair MCP Config` 之外的第三个命令名。
- 任何 P2 项与产品边界清单（见 `IMPLEMENTATION-PLAN.md` 顶部）内的功能。
