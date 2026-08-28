# Slice E — ux-release 实施细则（面板复用/序列化、空闲输出、欢迎页、MCP 提示、keepAlive、CI 打包、文档补齐）

> 本文是实现 Agent 的**唯一输入**。先读 `docs/handoffs/IMPLEMENTATION-PLAN.md` 总则，再按本文逐条落地。
> 行号以基线树 `cursor/implement-optimizations-11f8` 为参考，可能漂移；**以符号名为准**。

| 项 | 值 |
| --- | --- |
| 工作分支 | 从 `origin/cursor/implement-optimizations-11f8` 新建 `cursor/slice-e-ux-release-11f8`；**禁止 checkout / 提交 `main`** |
| 文件所有权 | `src/extension.ts`、`src/webview/TerminalPanel.ts`、`src/tree/TreeItems.ts`、`src/tree/ServerTreeProvider.ts`、`package.json`、`package.base.json`、`package.mcp.json`、`package.nls*`、`.github/workflows/ci.yml`、`scripts/package-variant.mjs`、`vitest.config.ts`、`docs/usage.md`、`docs/usage.zh-CN.md`、`README.md`、`docs/README.zh-CN.md`、`test/extension/**`、`test/webview/TerminalPanel.test.ts`、`test/package.variants.test.ts`、`test/package.baseBundle.test.ts` |
| 本切片额外认领（A–D 均未认领，允许直接改） | `webview/terminal/index.ts`（只加 setState 三行）、`test-fixtures/vscode.ts`（只追加 stub）、`test/tree/ServerTreeProvider.test.ts`（配套 E 拥有的两个 tree 源文件）、新文件 `src/config/keepAlive.ts`、`vitest.base.config.ts`、`test/extension/activation.base.test.ts`、`test/config/keepAlive.test.ts`、`test/docs/UsageCommandsDocs.test.ts` |
| 不许直接改 | `src/tree/SftpTreeProvider.ts` / `test/tree/SftpTreeProvider.test.ts`（C 所有 → 走 `_wiring-e.md`）、`src/webview/ServerFormPanel.ts`（无人认领但非 E 所有权 → 走 `_wiring-e.md`）、`src/mcp/**`（D 所有）、`src/ssh/**`（B 所有）、`src/agent/**`（A/D 所有）、`l10n/bundle.l10n.zh-cn.json`（A 所有，但见下文「l10n 冲突处理」） |
| 验收命令 | `npx tsc --noEmit`、`npx vitest run`、`npx vitest run --config vitest.base.config.ts` 三者全绿 |

**l10n 冲突处理**：`test/i18n/nls.test.ts` 会扫描 `src/**` 里所有 `t('...')` 字面量并要求 `l10n/bundle.l10n.zh-cn.json` 里存在对应键。E 新增的 `t()` 字符串若不进 bundle，全仓测试直接红。因此 E **在自己分支上直接向 bundle 追加键值**（纯新增、按现有字母序插入），同时把完整的 English → 中文 列表复制进 `docs/handoffs/_wiring-e.md`，供集成者与 A 的版本做并集合并。不得修改 A 已有条目。

---

## 1. Goal / Non-goals

### Goal（本切片必须交付）

1. 服务器树单击**复用**该服务器已有终端面板（含未连接的），不再每次新开 SSH；右键新增「SSH: New Terminal」显式开新面板；已连接服务器的 `contextValue` 变为 `server-connected`，右键提供 Disconnect。
2. Reload Window 后终端面板通过 `registerWebviewPanelSerializer` 恢复：只恢复 UI + 一键 Reconnect，**绝不自动连接**（重连仍走 hostKeyVerifier / keyboard-interactive / 凭据全链路）。服务器已被删除则弹提示并销毁面板。
3. 空闲断开把**输出**也算作活动（节流：输出路径最多每 5 秒重置一次计时器）；用户主动断开后输出事件不得复活会话；设置描述改为「无输入且无输出」。
4. SFTP 视图的 `viewsWelcome` 真正可见：`state.kind === 'none'` 时树返回 `[]`（经 wiring 交给集成者，文件属 C），欢迎文案带 `command:sshManager.connect` 链接（nls 属 E，直接改）。
5. MCP 安装/卸载命令在不支持的宿主上说实话：报出检测到的宿主名、列出支持的 IDE（Kiro / Cursor / Continue），提供「Copy Manual Config」「Open Usage Guide」动作；「打开工作区」提示只在宿主是 Continue 时出现。**不做** vscode `mcp.json` 写入器。
6. `sshManager.keepAliveInterval` 设置接线：作为**新建/导入服务器的默认值**与**服务器记录缺失该字段时的兜底**；每服务器表单值仍然优先。新增 `src/config/keepAlive.ts`（E 所有）。
7. CI：删除过时的 sibling `at-series-mcp-hub` checkout/构建（依赖已是 npm `@at-series/mcp-hub@^0.3.2`）；`test/package.variants.test.ts` 断言三个 manifest 版本一致；新增 `vitest.base.config.ts`（`MCP_ENABLED: false`）跑基础版激活冒烟；打包作为 `workflow_dispatch` 独立 job；`@vscode/vsce` 钉进 devDependencies。
8. 文档补齐：usage / usage.zh-CN / README 补上已交付但未写的命令与能力（Import SSH Config、Forward Local Port、View Host Fingerprint、Forget Host Key、Reconnect 细节、终端查找、会话日志、编码、目录上传/下载、ssh-agent、passphrase、keyboard-interactive/2FA、New Terminal）。**不动** A 拥有的 `docs/features*.md`。
9. 终端认证失败给出路：分类出认证错误后弹**持久**错误消息，带「Edit Server」「Retry」按钮；认证错误不再进入自动重连循环。
10. `pickServer` 空列表时给「Add Server」动作按钮，而不是让用户自己去找命令。
11. 只有一个分组时 `GroupTreeItem` 默认展开（`TreeItems.ts` + `ServerTreeProvider.ts` 小改）。

### Non-goals（明确不做，撞见也不要顺手改）

- vscode 宿主的 `mcp.json` 自动写入器（要先动上游 `@at-series/mcp-hub` 的 installer target，不在本切片）。
- walkthroughs contribution、publisher 从 `local` 迁移、`@vscode/test-electron` 完整 harness。
- 端口转发多条/状态管理、GBK/Big5 输入侧编码、SFTP 传输取消。
- 不改 `SftpManager` / `SshSession` / `McpConfigInstaller.resolveMcpInstallerTarget` 的任何逻辑。
- 不改主机密钥信任语义：变更默认阻断，恢复面板不得绕过任何 prompt。
- 不 bump 版本号（保持 0.3.4；`test/docs/McpDocs.test.ts` 钉着 `at-terminal-mcp-0.3.4.vsix`）。

---

## 2. Current（现状，逐项对照源码）

1. **树单击**：`ServerTreeItem` 构造器把 `this.command` 设为 `sshManager.connect`（`src/tree/TreeItems.ts` 43–47 行）；`extension.ts` 的 `sshManager.connect` 处理器无条件调用 `TerminalPanel.open(...)`（383–389 行）；`TerminalPanel.open` 每次 `createWebviewPanel`。`TerminalPanel` 已有 `private static readonly panels = new Set<TerminalPanel>()` 与 `private server`、`private connected` 字段，但没有按 serverId 查找/reveal 的静态 API。`ServerTreeItem.contextValue` 恒为 `'server'`。
2. **序列化**：全仓无 `registerWebviewPanelSerializer`；webview 端 `webview/terminal/index.ts` 的 `VsCodeApi` 类型只声明 `postMessage`，从不 `setState`。Reload Window 后 `sshTerminal` 面板变成空壳死标签。
3. **空闲断开**：`TerminalPanel.bind()` 里只有 `handleTerminalMessage` 返回 true（即 `input` / `ready` / `resize`）才 `scheduleIdleDisconnect()`；`createSession` 的 `output` 回调只写日志和推 batcher。`tail -f` 一小时被 `idleDisconnectMinutes`（默认 60）杀掉。设置描述（`atTerminal.config.idleDisconnectMinutes.description`）只说 "Disconnect idle SSH terminals"。
4. **SFTP 欢迎页**：`SftpTreeProvider.getChildren` 在 `state.kind === 'none'` 时返回 `[new SftpPlaceholderTreeItem(t('No active SSH terminal'))]`（71 行）——树非空于是 `viewsWelcome` 被 VS Code 抑制。`disconnected` 状态返回快照 entries（不是占位符，保持不动）。nls 的 `atTerminal.viewsWelcome.sftpFiles` 是纯文本无命令链接。
5. **MCP 提示**：`McpConfigInstaller.resolveMcpInstallerTarget`（D 所有）对 `kiro`/`cursor` 返回 target，`continue` 需 workspaceFolder，**其余（含 vscode/windsurf/qoder/unknown）返回 undefined**。`extension.ts` 的 `sshManager.installMcpConfig` 处理器在 `ensureAtSeriesConfigForCurrentIde` 返回 undefined 时统一弹 `t('No supported IDE MCP config target was detected. Open a workspace to install Continue config.')`（257–259 行）；uninstall 同款（274–276 行）。在 VS Code 里这句是假话。`hostApp` 变量（`detectHostApp(hostEnv)` 结果）在 MCP 块内、两个命令闭包可见。`HostApp` 类型为 `'vscode' | 'cursor' | 'kiro' | 'qoder' | 'windsurf' | 'continue' | 'unknown' | (string & {})`。
6. **keepAlive**：`package.json` contributes `sshManager.keepAliveInterval`（default 30），nls/usage 都写了，但运行时**没有任何代码读它**。实际值全部来自 `server.keepAliveInterval`（zod schema 必填 `z.number().int().min(0)`；表单默认 30 写死在 `src/webview/ServerFormPanel.ts` 259/325 行；`extension.ts` 的 `importSshConfig` 写死 `keepAliveInterval: 30`，487 行）。消费点在 `src/ssh/SshConnectionConfig.ts` 的 `buildSshConnectConfig`（B 所有，不改）。
7. **CI**：`.github/workflows/ci.yml` 仍然双 checkout（`at-terminal-series` + `xwamt/at-series-mcp-hub` sibling）并 `npm run build:hub`，然后在子目录跑 typecheck/test/audit——但 `package.json` 里 `@at-series/mcp-hub` 已是 npm `^0.3.2`，sibling 布局早已失效。`scripts/package-variant.mjs` 用 `npx @vscode/vsce`（未钉版本）且从不在 CI 跑。`vitest.config.ts` 写死 `define: { MCP_ENABLED: 'true' }`，基础版（false 分支）从未在测试下执行过。`test/package.variants.test.ts` 不校验三个 manifest 的 `version` 相等（当前碰巧都是 0.3.4）。
8. **文档**：`docs/usage.md` / `docs/usage.zh-CN.md` 的 Commands 列表缺 `SSH: Import from SSH Config`、`SSH: Forward Local Port`、`SSH: View Host Fingerprint`、`SSH: Forget Host Key`；没有任何地方写终端查找（Ctrl+F）、会话日志、每服务器编码（仅显示）、SFTP 目录上传/下载、ssh-agent、私钥 passphrase、keyboard-interactive/2FA、自动重连。README.md / docs/README.zh-CN.md 能力列表同样缺。
9. **认证失败**：`TerminalPanel.connect()`/`reconnect()` 的 catch 只 `postStatus(disconnected + formatError)`；webview 只有 Reconnect 按钮，密码错就永远撞同一堵墙。`isHostVerificationError` 已存在并且会停自动重连，但认证失败会继续自动重连三次。
10. **pickServer**：`extension.ts` 的 `pickServer` 在 0 台服务器时只 `showInformationMessage(t('No SSH servers configured yet. Run "SSH: Add Server" to create one.'))`，无动作按钮。
11. **分组**：`GroupTreeItem` 恒为 `Collapsed`；只有一个 Default 分组的新用户要先点开分组才能看到服务器。

---

## 3. Target（目标行为）

逐项与 Current 对应；细节见 §4 File-by-file。

1. 单击树节点 → `sshManager.connect` → 若该 `server.id` 已有面板（**优先已连接的；一个都没连上则复用最近创建的未连接面板**）则 `reveal` 之，不新建、不发起连接；否则 `TerminalPanel.open`。右键「SSH: New Terminal」（`sshManager.newTerminal`）总是新开。已连接服务器 `contextValue = 'server-connected'`，右键出现「SSH: Disconnect」，断开该服务器**全部**面板（面板保留、显示 disconnected + Reconnect）。
2. 恢复：webview 加载时 `vscode.setState({ serverId })`；`registerWebviewPanelSerializer('sshTerminal', ...)` 用纯函数 `deserializeTerminalState` 校验 state → 查 `configManager.getServer` → 存在则 `TerminalPanel.restore(...)`（渲染 HTML、初始 header 即 disconnected + 可见 Reconnect 按钮，不 connect）；不存在则提示后 `panel.dispose()`。
3. `createSession` 的 output 回调调用节流的 `noteOutputActivity()`（`IDLE_OUTPUT_ACTIVITY_THROTTLE_MS = 5_000`）；`disconnectWithStatus` 之后 `connected === false`，输出事件不会再排计时器。
4. `SftpTreeProvider.getChildren`：`none` → `[]`（wiring 补丁）；nls 欢迎文案换成带 `[Connect to a Server](command:sshManager.connect)` 的版本。
5. `sshManager.installMcpConfig` / `sshManager.uninstallAtSeriesMcpConfig` 在 target 为 undefined 时：Continue 无工作区 → 提示打开工作区；其余宿主 → 报宿主名 + 支持列表 + 「Copy Manual Config」（复制 hub.js 绝对路径的 JSON 片段）+ 「Open Usage Guide」（`markdown.showPreview` 打开打包内 `docs/usage.md`）。激活时的静默 ensure 失败路径**保持静默**（不加启动噪声）。
6. `resolveKeepAliveInterval(server, configuration)`：服务器值为合法数字（含 0）则用之；否则读 `sshManager.keepAliveInterval` 设置；设置非法再兜底 30。接线点：`TerminalPanel.open`、`TerminalPanel.restore`、`extension.ts` 的 `forwardLocalPort`、`importSshConfig`（新建记录直接写设置值）；表单默认值改读设置（wiring）。
7. CI 单 checkout + `npm ci` + typecheck + 双 vitest + audit；`package` job 仅 `workflow_dispatch` 触发，产出两个 VSIX artifact。variants 测试加版本一致断言。
8. 文档补齐；不碰 `docs/features*.md` 的 Limited-trust 句（若 A 未合入、旧句还在，也留给 A）。新增 drift 测试 `test/docs/UsageCommandsDocs.test.ts`：`package.nls.json` 里每个 `atTerminal.command.*.title` 的英文标题必须出现在 `docs/usage.md` 与 `docs/usage.zh-CN.md`。
9. `isLikelyAuthenticationError`（本地字符串匹配版，B 的分类器合入后由集成者换成分类码，见 wiring）→ `connect`/`reconnect` 失败时弹持久错误 + Edit Server / Retry；认证错误与主机密钥错误同等待遇：立即停止自动重连。
10. `pickServer` 空列表 → `showInformationMessage(..., t('Add Server'))`，点击后 `executeCommand('sshManager.addServer')`。
11. 分组数为 1 时 `GroupTreeItem` 以 `Expanded` 创建。

---

## 4. File-by-file（逐文件改动）

### 4.1 `src/webview/TerminalPanel.ts`

**(a) 面板注册表与复用 API。** 内部保持现有 `private static readonly panels = new Set<TerminalPanel>()`（**不要**换成 `Map<serverId, TerminalPanel>`：「New Terminal」允许同一服务器多面板，Map 会互相顶掉）。新增：

```ts
getServerId(): string {
  return this.server.id;
}

isConnected(): boolean {
  return this.connected;
}

reveal(): void {
  this.panel.reveal();
}

/** 复用策略：优先已连接面板（多个时取最后注册的）；一个都没连上则取最后注册的任意面板。 */
static findByServerId(serverId: string): TerminalPanel | undefined {
  const candidates = Array.from(TerminalPanel.panels).filter(
    (terminal) => terminal.server.id === serverId
  );
  if (candidates.length === 0) {
    return undefined;
  }
  return [...candidates].reverse().find((terminal) => terminal.connected) ?? candidates[candidates.length - 1];
}

/** 找到则 reveal 并返回该面板；找不到返回 undefined（调用方据此决定是否新建）。 */
static reveal(serverId: string): TerminalPanel | undefined {
  const existing = TerminalPanel.findByServerId(serverId);
  existing?.reveal();
  return existing;
}

/** 断开（不销毁）该服务器的全部面板，返回断开数量。 */
static disconnectByServerId(serverId: string): number {
  let count = 0;
  for (const terminal of TerminalPanel.panels) {
    if (terminal.server.id === serverId) {
      terminal.disconnect();
      count += 1;
    }
  }
  return count;
}
```

注意 `onDidDispose` 已经做 `TerminalPanel.panels.delete(this)`，所以 `findByServerId` 不会捞到已销毁面板；`disconnect()` 不从 Set 移除（面板还在，只是断线），这正是「复用未连接面板」的来源。

**(b) 序列化状态（纯函数）。**

```ts
export interface RestoredTerminalState {
  serverId: string;
}

/** Webview getState() 的载荷是不可信输入：损坏/旧版本 state 一律返回 undefined，由调用方销毁面板。 */
export function deserializeTerminalState(state: unknown): RestoredTerminalState | undefined {
  if (typeof state !== 'object' || state === null) {
    return undefined;
  }
  const serverId = (state as { serverId?: unknown }).serverId;
  return typeof serverId === 'string' && serverId.length > 0 ? { serverId } : undefined;
}
```

**(c) `renderTerminalBody` 携带 serverId 与恢复态。** 签名改为（第二参可选，现有测试调用不破）：

```ts
export interface TerminalBodyOptions {
  serverId?: string;
  restored?: boolean;
}

export function renderTerminalBody(settings: TerminalSettings, options: TerminalBodyOptions = {}): string
```

改动点：
- `<section id="terminal" ...>` 增加 `data-server-id="${escapeAttr(options.serverId ?? '')}"`（空串则省略该属性亦可，但选一种并写测试）。
- header：`options.restored` 为 true 时初始 class 用 `terminal-status terminal-status--disconnected`（否则维持 `--connecting`），状态文本用 `t('Restored session. Press Reconnect to connect.')`（否则 `t('Starting...')`），Reconnect 按钮**不带** `hidden`（否则维持 `hidden`）。这样恢复面板不依赖 postMessage 时序，webview 一加载就能点 Reconnect。

`TerminalPanel.open` 里的调用改为 `renderTerminalBody(settings, { serverId: server.id })`。

**(d) `TerminalPanel.restore` 静态方法。**

```ts
static restore(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  server: ServerConfig,
  configManager: ConfigManager,
  hostKeyVerifier: HostKeyVerifier,
  terminalContext?: TerminalContextRegistry
): TerminalPanel {
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [context.extensionUri]
  };
  const settings = resolveTerminalSettings(vscode.workspace.getConfiguration('sshManager'), server);
  const terminal = new TerminalPanel(panel, server, configManager, settings, hostKeyVerifier, terminalContext);
  TerminalPanel.active = terminal;
  // 恢复的会话等同「用户曾主动断开」：禁止任何自动重连路径把它连上；
  // 用户点 Reconnect 才走 hostKeyVerifier / keyboard-interactive / 凭据全链路。
  terminal.userDisconnected = true;
  panel.webview.html = renderWebviewHtml(
    panel.webview,
    createTerminalAssets(context.extensionUri),
    renderTerminalBody(settings, { serverId: server.id, restored: true })
  );
  terminal.bind();
  terminal.publishContext();
  return terminal;
}
```

要点：**不调用 `terminal.connect()`**；构造器会照常 `createSession`（未连接的 SshSession，无副作用），用户点 Reconnect 时 `reconnect()` 会 dispose 再重建。keepAlive 兜底见 4.4（`resolveTerminalSettings` 不管 keepAlive；`restore`/`open` 传入的 `server` 先按 4.4 归一化）。

**(e) 空闲计时把输出算活动（节流）。**

```ts
export const IDLE_OUTPUT_ACTIVITY_THROTTLE_MS = 5_000;
```

实例字段 `private lastOutputActivityAt = 0;`，新私有方法：

```ts
private noteOutputActivity(): void {
  if (!this.connected || this.settings.idleDisconnectMinutes <= 0) {
    return;
  }
  const now = Date.now();
  if (now - this.lastOutputActivityAt < IDLE_OUTPUT_ACTIVITY_THROTTLE_MS) {
    return;
  }
  this.lastOutputActivityAt = now;
  this.scheduleIdleDisconnect();
}
```

`createSession` 的 output 回调改为：

```ts
output: (data) => {
  this.sessionLog?.append(data);
  this.noteOutputActivity();
  outputBatcher.push(data);
},
```

`this.connected` 守卫保证：用户 `disconnect()`（会把 `connected` 置 false 并 `clearIdleDisconnect`）之后，迟到的 output 事件不会重排计时器，更不会重连——现有「does not auto-reconnect after a user-initiated disconnect」测试必须保持绿。

**(f) 认证失败出路。**

```ts
/**
 * 本地兜底分类。B 切片交付 ssh 错误分类器后由集成者替换为分类码判断
 * （见 docs/handoffs/_wiring-e.md「认证分类器接线」）。ssh2 的认证失败文案：
 * "All configured authentication methods failed"。
 */
export function isLikelyAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /all configured authentication methods failed|authentication (?:failed|failure)|permission denied \(publickey|password\)/i.test(message);
}
```

新私有方法：

```ts
private offerAuthFailureActions(error: unknown): void {
  const editAction = t('Edit Server');
  const retryAction = t('Retry');
  void showErrorWithActions(
    t('Authentication to {label} failed: {message}', {
      label: this.server.label,
      message: formatError(error)
    }),
    editAction,
    retryAction
  ).then((choice) => {
    if (this.disposed) {
      return;
    }
    if (choice === editAction) {
      // editServer 处理器接受 { server } 形状的 item（结构化兼容 ServerTreeItem）。
      void vscode.commands.executeCommand('sshManager.editServer', { server: this.server });
      return;
    }
    if (choice === retryAction) {
      void this.reconnect();
    }
  });
}
```

`showErrorWithActions` 从 `../utils/notifications` 导入（文件里已 import `showTimedNotification`，同一模块追加即可）。

接线（两处 catch，均在 `postStatus({state:'disconnected',...})` 之后）：

- `connect()` catch 末尾追加：

```ts
if (isLikelyAuthenticationError(error)) {
  this.offerAuthFailureActions(error);
}
```

- `reconnect()` catch：在现有 `isHostVerificationError` 分支**之后、`if (options.auto)` 之前**插入：

```ts
if (isLikelyAuthenticationError(error)) {
  // 凭据不改，重试永远撞同一错误：像主机密钥一样立即停自动重连。
  this.postTerminalNotice(t('Reconnect stopped: authentication failed. Edit the server credentials and retry.'));
  this.offerAuthFailureActions(error);
  return;
}
```

### 4.2 `webview/terminal/index.ts`（仅三处小改）

1. `VsCodeApi` 类型扩为 `{ postMessage(message: unknown): void; setState(state: unknown): void; getState(): unknown }`。
2. 取到 `container` 之后（现有 `if (!container) throw` 之后任意早点）：

```ts
const serverId = container.dataset.serverId;
if (serverId) {
  vscode.setState({ serverId });
}
```

3. 无其他改动。不读 getState（恢复流程由扩展侧驱动）。

### 4.3 `src/extension.ts`

**(a) `sshManager.connect` 复用。** 替换现有处理器体：

```ts
vscode.commands.registerCommand('sshManager.connect', async (item?: ServerTreeItem) => {
  const server = item?.server ?? (await pickServer(configManager));
  if (!server) {
    return;
  }
  if (TerminalPanel.reveal(server.id)) {
    return;
  }
  TerminalPanel.open(context, server, configManager, hostKeyVerifier, terminalContext);
});
```

**(b) 新命令 `sshManager.newTerminal`。** 紧随 connect 注册：

```ts
vscode.commands.registerCommand('sshManager.newTerminal', async (item?: ServerTreeItem) => {
  const server = item?.server ?? (await pickServer(configManager));
  if (!server) {
    return;
  }
  TerminalPanel.open(context, server, configManager, hostKeyVerifier, terminalContext);
});
```

**(c) `sshManager.disconnect` 支持树上下文。** 替换现有处理器体：

```ts
vscode.commands.registerCommand('sshManager.disconnect', (item?: ServerTreeItem) => {
  if (item?.server) {
    if (TerminalPanel.disconnectByServerId(item.server.id) === 0) {
      void vscode.window.showInformationMessage(
        t('No SSH terminal is open for {label}.', { label: item.server.label })
      );
    }
    return;
  }
  const active = TerminalPanel.getActive();
  if (!active) {
    void vscode.window.showInformationMessage(t('No active SSH terminal'));
    return;
  }
  active.disconnect();
});
```

**(d) 序列化器注册。** 在 `context.subscriptions.push(...)` 大列表里（`createTreeView` 之前或之后皆可）加入：

```ts
vscode.window.registerWebviewPanelSerializer('sshTerminal', {
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const restored = deserializeTerminalState(state);
    if (!restored) {
      panel.dispose();
      return;
    }
    const server = await configManager.getServer(restored.serverId);
    if (!server) {
      showTimedNotification(
        t('A saved SSH terminal could not be restored because its server no longer exists.'),
        'warning'
      );
      panel.dispose();
      return;
    }
    TerminalPanel.restore(
      panel,
      context,
      withResolvedKeepAlive(server),
      configManager,
      hostKeyVerifier,
      terminalContext
    );
  }
}),
```

导入：`deserializeTerminalState` 加进现有 `from './webview/TerminalPanel'` 导入。注册放在 **MCP 块之外**——base 构建同样要恢复面板。首字符串 viewType 必须与 `TerminalPanel.open` 的 `'sshTerminal'` 完全一致。

**(e) MCP 安装/卸载诚实提示（仅 MCP 块内）。** 顶层新增两个**导出**纯函数（放在 `promptChangedHostKey` 附近，供测试直接 import；不引用 MCP 块内变量）：

```ts
export function formatMcpTargetNotDetectedMessage(hostApp: string, hasWorkspace: boolean): string {
  if (hostApp === 'continue' && !hasWorkspace) {
    return t('Open a workspace folder so the Continue MCP config can be written to .continue/mcpServers/at-terminal.yaml.');
  }
  return t(
    'Automatic MCP config supports Kiro, Cursor, and Continue (with an open workspace). Detected IDE: {hostApp}. Use "Copy Manual Config" to configure any other MCP client.',
    { hostApp }
  );
}

export function buildManualMcpConfigSnippet(hostApp: string, hubPath: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        'AT Series': {
          command: 'node',
          args: [hubPath],
          env: { AT_SERIES_HOST_APP: hostApp === 'unknown' ? 'vscode' : hostApp }
        }
      }
    },
    null,
    2
  )}\n`;
}
```

`hubPath` 由调用方传 `hubJsPath()`（把 `hubJsPath` 加进现有 `import { detectHostApp } from '@at-series/mcp-hub'`；base 构建里该导入被 esbuild stub 成 undefined，但调用点全部在 `if (MCP_ENABLED)` 内，安全）。参考片段（usage.md 已有的形态，`~/.at-series/mcp/hub.js`）——复制到剪贴板的内容形如：

```json
{
  "mcpServers": {
    "AT Series": {
      "command": "node",
      "args": ["/home/you/.at-series/mcp/hub.js"],
      "env": {
        "AT_SERIES_HOST_APP": "vscode"
      }
    }
  }
}
```

`sshManager.installMcpConfig` 处理器里，把结尾的

```ts
void vscode.window.showWarningMessage(
  t('No supported IDE MCP config target was detected. Open a workspace to install Continue config.')
);
```

替换为：

```ts
const copyAction = t('Copy Manual Config');
const openUsageAction = t('Open Usage Guide');
void vscode.window
  .showWarningMessage(
    formatMcpTargetNotDetectedMessage(hostApp, currentWorkspaceFolder() !== undefined),
    copyAction,
    openUsageAction
  )
  .then(async (choice) => {
    if (choice === copyAction) {
      await vscode.env.clipboard.writeText(buildManualMcpConfigSnippet(hostApp, hubJsPath()));
      showTimedNotification(t('Manual MCP config copied to the clipboard.'));
      return;
    }
    if (choice === openUsageAction) {
      await vscode.commands.executeCommand(
        'markdown.showPreview',
        vscode.Uri.joinPath(context.extensionUri, 'docs', 'usage.md')
      );
    }
  });
```

`sshManager.uninstallAtSeriesMcpConfig` 处理器末尾同理替换为：

```ts
void vscode.window.showWarningMessage(
  t('No MCP config was removed. Automatic MCP config supports Kiro, Cursor, and Continue. Detected IDE: {hostApp}.', {
    hostApp
  })
);
```

激活时的 `hubReady.then(() => ensureAtSeriesConfigForCurrentIde(...))` 静默路径**不改**（返回 undefined 时依旧无声；只有用户显式跑命令才展示诚实提示）。

**(f) keepAlive 接线。** 顶部 `import { resolveKeepAliveInterval } from './config/keepAlive';`，`activate` 内定义局部助手：

```ts
const withResolvedKeepAlive = (server: ServerConfig): ServerConfig => ({
  ...server,
  keepAliveInterval: resolveKeepAliveInterval(server, vscode.workspace.getConfiguration('sshManager'))
});
```

接线点：
- `sshManager.connect` / `sshManager.newTerminal`：`TerminalPanel.open(context, withResolvedKeepAlive(server), ...)`。
- 序列化器（见 (d)）已用 `withResolvedKeepAlive(server)`。
- `sshManager.forwardLocalPort`：`buildSshConnectionHandle(withResolvedKeepAlive(server), configManager, hostKeyVerifier, ...)`。
- `sshManager.importSshConfig`：`keepAliveInterval: 30` → `keepAliveInterval: resolveKeepAliveInterval({}, vscode.workspace.getConfiguration('sshManager'))`。

**(g) `pickServer` 空态动作。** 替换空列表分支：

```ts
if (servers.length === 0) {
  const addAction = t('Add Server');
  void vscode.window
    .showInformationMessage(t('No SSH servers configured yet. Add one to get started.'), addAction)
    .then((choice) => {
      if (choice === addAction) {
        void vscode.commands.executeCommand('sshManager.addServer');
      }
    });
  return undefined;
}
```

（旧字符串 `No SSH servers configured yet. Run "SSH: Add Server" to create one.` 在 src 中不再出现即可，bundle 里的旧译文留着无害。）

### 4.4 `src/config/keepAlive.ts`（新文件，E 所有）

```ts
export const KEEP_ALIVE_DEFAULT_SECONDS = 30;

export interface KeepAliveConfigurationLike {
  get<T>(key: string, defaultValue: T): T;
}

/**
 * 每服务器值（含 0 = 关闭）永远优先；只有字段缺失/非法时才落到
 * `sshManager.keepAliveInterval` 设置，设置本身非法再兜底 30。
 * 之所以不把「服务器值恰为 30」也视作默认回落到设置：30 可能是用户
 * 有意填写的值，覆盖它会让表单值失效，违反文档承诺。
 */
export function resolveKeepAliveInterval(
  server: { keepAliveInterval?: number },
  configuration: KeepAliveConfigurationLike
): number {
  const serverValue = server.keepAliveInterval;
  if (typeof serverValue === 'number' && Number.isFinite(serverValue) && serverValue >= 0) {
    return serverValue;
  }
  const settingValue = configuration.get('keepAliveInterval', KEEP_ALIVE_DEFAULT_SECONDS);
  if (typeof settingValue === 'number' && Number.isFinite(settingValue) && settingValue >= 0) {
    return settingValue;
  }
  return KEEP_ALIVE_DEFAULT_SECONDS;
}
```

注：schema 仍然必填该字段，所以运行期兜底主要覆盖手工导入的资产/历史数据与未来 schema 放宽；「设置作为新服务器默认值」由 (f) 的 import 改动 + wiring 里的表单改动兑现。**不改 schema、不改 src/ssh。**

### 4.5 `src/tree/TreeItems.ts`

```ts
export class GroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly groupName: string,
    expanded = false
  ) {
    super(
      groupName,
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = 'group';
  }
}
```

`ServerTreeItem` 构造器中 `this.contextValue = 'server';` 改为：

```ts
this.contextValue = connectionState === 'connected' ? 'server-connected' : 'server';
```

其余（图标/描述/命令）不动——单击命令仍是 `sshManager.connect`，复用逻辑在处理器里。

### 4.6 `src/tree/ServerTreeProvider.ts`

`getChildren` 根分支改为：

```ts
if (!element) {
  const groups = Array.from(new Set(servers.map((server) => this.groupName(server)))).sort((a, b) =>
    a.localeCompare(b)
  );
  return groups.map((group) => new GroupTreeItem(group, groups.length === 1));
}
```

### 4.7 三个 manifest：`package.json`、`package.base.json`、`package.mcp.json`（同步改，内容一致；MCP 专属命令仅在 package.json 与 package.mcp.json）

1. `contributes.commands` 追加（三个 manifest 都加）：

```json
{
  "command": "sshManager.newTerminal",
  "title": "%atTerminal.command.newTerminal.title%",
  "icon": "$(terminal)",
  "category": "AT Terminal"
}
```

2. `menus["view/item/context"]`：
   - 现有 6 条 `viewItem == server` 的 when（editServer、deleteServer、copyHost、viewHostFingerprint、forgetHostKey、forwardLocalPort）全部改为
     `"view == sshManager.servers && (viewItem == server || viewItem == server-connected)"`。
   - 追加：

```json
{
  "command": "sshManager.newTerminal",
  "when": "view == sshManager.servers && (viewItem == server || viewItem == server-connected)",
  "group": "terminal@1"
},
{
  "command": "sshManager.disconnect",
  "when": "view == sshManager.servers && viewItem == server-connected",
  "group": "terminal@2"
}
```

3. `configuration.properties` 不增删键；仅 nls 描述文案变化（见 §6）。
4. `viewsWelcome` 结构不动（仍是两个 `%placeholder%` 项），值在 nls 改。

### 4.8 `package.nls.json` / `package.nls.zh-cn.json`

见 §6 键表。两个文件键集合必须完全一致（`test/i18n/nls.test.ts` 钉着）。

### 4.9 `.github/workflows/ci.yml`（整文件替换）

```yaml
name: CI

on:
  push:
    branches: [master, main]
  pull_request:
  workflow_dispatch:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      # @at-series/mcp-hub 现在是 npm 依赖（^0.3.2），不再需要 sibling checkout/构建。
      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Test (MCP defines, includes base-bundle build assertions)
        run: npm test

      - name: Test (base defines, MCP_ENABLED=false activation smoke)
        run: npx vitest run --config vitest.base.config.ts

      - name: Audit production dependencies
        run: npm audit --omit=dev --audit-level=high

  package:
    # vsce 打包 + npm install --omit=dev 较重，不上每次 PR；手动触发验证发版产物。
    if: github.event_name == 'workflow_dispatch'
    needs: check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Package base VSIX
        run: npm run package:base

      - name: Package MCP VSIX
        run: npm run package:mcp

      - name: Verify VSIX artifacts
        run: |
          node -e "
            const { statSync } = require('node:fs');
            const version = require('./package.json').version;
            for (const name of ['at-terminal-' + version + '.vsix', 'at-terminal-mcp-' + version + '.vsix']) {
              const size = statSync(name).size;
              if (size < 100_000) throw new Error(name + ' is suspiciously small: ' + size);
              console.log(name, size, 'bytes');
            }
          "

      - uses: actions/upload-artifact@v4
        with:
          name: vsix
          path: '*.vsix'
```

要点：删除全部 sibling hub 步骤与 `working-directory: at-terminal-series`；`workflow_dispatch` 同时作为 `on` 触发器与 `package` job 的 `if` 条件。

### 4.10 根 `package.json` 的 scripts / devDependencies

- `scripts` 追加：`"test:base": "vitest run --config vitest.base.config.ts"`。
- devDependencies 追加 `@vscode/vsce`：执行 `npm install --save-dev @vscode/vsce`（取当前最新 ^3.x，写 lock）。`scripts/package-variant.mjs` 的 `npx @vscode/vsce` 调用**不改**——devDependency 在位后 npx 直接解析本地版本，不再临时下载（stage 目录位于 `<root>/.package-work/<variant>`，npx 沿目录向上找得到根 node_modules）。

### 4.11 `vitest.config.ts` 与新文件 `vitest.base.config.ts`

`vitest.config.ts`：排除 base 专用测试，避免在 `MCP_ENABLED: 'true'` 下重复执行：

```ts
import { resolve } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors esbuild's define (see src/buildFlags.d.ts). Tests cover the MCP build;
  // base-variant defines run through vitest.base.config.ts.
  define: {
    MCP_ENABLED: 'true'
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/**/*.base.test.ts'],
    fileParallelism: false
  },
  resolve: {
    alias: {
      vscode: resolve(process.cwd(), 'test-fixtures/vscode.ts')
    }
  }
});
```

`vitest.base.config.ts`（新文件）：

```ts
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    MCP_ENABLED: 'false'
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.base.test.ts'],
    fileParallelism: false
  },
  resolve: {
    alias: {
      vscode: resolve(process.cwd(), 'test-fixtures/vscode.ts')
    }
  }
});
```

### 4.12 `test-fixtures/vscode.ts`（追加 stub，不改既有导出）

`window` 对象追加：

```ts
registerWebviewPanelSerializer: (_viewType: string, _serializer: unknown) => ({ dispose: () => undefined }),
```

（若测试需要触发反序列化，测试内用 `vi.spyOn(vscode.window, 'registerWebviewPanelSerializer')` 捕获 serializer 实参，不需要 fixture 存储。）

### 4.13 `docs/usage.md`

1. `## Commands` → `Server commands` 列表补（保持现有顺序在后追加）：

```markdown
- `SSH: New Terminal` (context menu; always opens another terminal for the server)
- `SSH: Import from SSH Config`
- `SSH: Forward Local Port`
- `SSH: View Host Fingerprint`
- `SSH: Forget Host Key`
```

并在列表后追加一句：`Clicking a server in the tree reveals its existing terminal if one is open; use \`SSH: New Terminal\` to open another one.`

2. `## Settings` 更新两条：

```markdown
- `sshManager.idleDisconnectMinutes`: disconnect SSH terminals after this many minutes with no input and no output. `0` disables idle disconnect.
- `sshManager.keepAliveInterval`: default SSH keep-alive interval in seconds for new and imported servers, and the fallback when a server has no value of its own. The per-server value in the server form always wins. `0` disables keep-alive.
```

3. `## Commands` 之前插入新节 `## Terminal And Authentication Features`（标题必须原样，zh 版对应「## 终端与认证能力」）：

```markdown
## Terminal And Authentication Features

- Authentication: password, private key (with passphrase prompt support), and ssh-agent (`SSH_AUTH_SOCK`, Windows OpenSSH agent pipe).
- Keyboard-interactive / 2FA: OTP and PAM prompts are answered through input boxes during connect.
- Jump host: one hop via the server's jump host setting.
- Host fingerprints: first-use trust prompt, `SSH: View Host Fingerprint`, `SSH: Forget Host Key`; a changed key blocks the connection until you decide.
- Reconnect: a Reconnect button appears when a session drops; unexpected drops retry up to 3 times with backoff. Restored terminals after Reload Window never reconnect automatically.
- Find in terminal: `Ctrl+F` / `Cmd+F` opens the search bar.
- Session logs: set `sshManager.sessionLogDirectory` to append raw terminal output to `<label>-<id>.log`.
- Output encoding: per-server `utf-8` / `gbk` / `big5` decoding of terminal output (display only).
- SFTP transfers: upload and download work for single files and whole directories, with overwrite/skip conflict prompts.
```

4. 其余（MCP 各节、版本号 `at-terminal-mcp-0.3.4.vsix`）不动。

### 4.14 `docs/usage.zh-CN.md`

与 4.13 逐条镜像：`## 命令` 服务器命令补 `SSH: New Terminal`、`SSH: Import from SSH Config`、`SSH: Forward Local Port`、`SSH: View Host Fingerprint`、`SSH: Forget Host Key`（命令名保持英文原文，与命令面板一致）+ 单击复用说明；`## 设置` 两条描述更新；新节 `## 终端与认证能力` 翻译 4.13 的九条。注意 `test/docs/UsageCommandsDocs.test.ts`（4.18）要求**英文命令标题原样出现在 zh 文档里**，所以列表项照抄英文标题、解释用中文。

### 4.15 `README.md` 与 `docs/README.zh-CN.md`

- README.md：在能力/Capability 相关小节（`| Capability | Base \`AT Terminal\` | \`AT Terminal MCP\` |` 表之后）追加一段 bullet：terminal panel reuse + New Terminal、Reload Window restore（manual reconnect）、idle disconnect counts output、keyboard-interactive/2FA、ssh-agent、passphrase、host fingerprint commands、SSH config import、local port forward、session logs、find、per-server encoding（display only）、SFTP directory upload/download。**不得改动**任何 Limited-trust 措辞与 `docs/features.md` 链接行（`test/docs/McpDocs.test.ts` 钉着若干句子）。
- docs/README.zh-CN.md：`### 功能总览` 或等效列表追加同样内容的中文 bullet。**若发现 features.md 仍是旧的 allow-list 句子，不改——那是 A 的交付物。**

### 4.16 `test/package.variants.test.ts`

1. 新增用例：

```ts
it('keeps package.json, package.base.json and package.mcp.json versions in lockstep', () => {
  const rootManifest = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(baseManifest.version).toBe(rootManifest.version);
  expect(mcpManifest.version).toBe(rootManifest.version);
});
```

2. 修改既有用例 `contributes host key commands on the server context menu in every variant`：两个 `objectContaining` 的 `when` 期望值改为
   `'view == sshManager.servers && (viewItem == server || viewItem == server-connected)'`。
3. 新增用例断言三个 manifest 都有 `sshManager.newTerminal` 命令 + 两条新菜单项（newTerminal 的 when 含 `server-connected`；disconnect 的 when 为 `view == sshManager.servers && viewItem == server-connected`）。
4. 新增用例断言 CI 不再引用 sibling hub：

```ts
it('does not build a sibling hub checkout in CI anymore', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  expect(ci).not.toContain('at-series-mcp-hub');
  expect(ci).not.toContain('working-directory: at-terminal-series');
  expect(ci).toContain('workflow_dispatch');
  expect(ci).toContain('vitest.base.config.ts');
});
```

### 4.17 `test/webview/TerminalPanel.test.ts`

`createPanel()` 的 panel mock 追加 `reveal: vi.fn()` 与可写 `webview.options`（普通对象属性即可）。新增用例（describe 建议名给全）：

- `describe('terminal panel reuse')`
  - `reveals the connected panel for a server instead of opening a duplicate`：同一 server 开两个面板（第二个 `disconnect()`），`TerminalPanel.reveal(id)` 返回连接中的那个并调用其 panel.reveal。
  - `falls back to the most recent disconnected panel when nothing is connected`。
  - `returns undefined for a server without panels`。
  - `disconnectByServerId disconnects every panel of that server and returns the count`（两面板同 server → 返回 2，`disposeSession` 调用两次，面板仍在 `panels`（用 `TerminalPanel.reveal(id)` 仍能找到佐证））。
- `describe('terminal state serialization')`
  - `deserializeTerminalState accepts { serverId } and rejects garbage`：`{serverId:'a'}` → `{serverId:'a'}`；`undefined` / `null` / `{}` / `{serverId:''}` / `{serverId:1}` / `'x'` → `undefined`。
  - `renderTerminalBody embeds the server id and a visible reconnect button when restored`：`renderTerminalBody(terminalSettings(), { serverId: 's1', restored: true })` 含 `data-server-id="s1"`、`terminal-status--disconnected`、Reconnect 按钮**无** `hidden`；默认调用（无 options）不含 `data-server-id` 且 Reconnect 有 `hidden`（若选择空串属性方案，则断言相应形态）。
  - `restore builds a panel that does not connect until the user asks`：`TerminalPanel.restore(panelHost.panel, extensionContext(), server(), ...)` → `connect` 未被调用、`panelHost.panel.webview.html` 非空；`panelHost.fireMessage({ type: 'reconnect' })` + `flushPromises()` → `connect` 恰被调用一次。
  - `restore joins the shared registry so updateServer reaches it`：restore 后 `TerminalPanel.updateServer({...})` 生效（复用现有 updateServer 用例套路）。
- `describe('idle disconnect counts output')`（fake timers；沿用现有 idle 用例的 `getConfiguration` mock，`idleDisconnectMinutes: 1`）
  - `output resets the idle timer`：t=30s 发 `sessionEvents.at(-1)!.output(...)` → `advanceTimersByTime(30_000)`（到 60s）不断开；再 advance 30s（到 90s）断开。
  - `output resets are throttled to once per 5 seconds`：t=1s 与 t=3s 各发一次 output → 断开发生在 61s（第二次没有重排），即 advance 到 60_999 仍连接、61_001 已断开。
  - `output after a user disconnect does not resurrect the session`：`terminal.disconnect()` 后发 output + advance 10 分钟 → `connect` 调用数不变、无 Reconnecting notice。
- `describe('authentication failure actions')`
  - `offers Edit Server and Retry on classified auth errors`：`connect.mockRejectedValueOnce(new Error('All configured authentication methods failed'))`，`vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Edit Server' 的实际文案)`、`vi.spyOn(vscode.commands, 'executeCommand')` → open + flush → `executeCommand` 以 `('sshManager.editServer', expect.objectContaining({ server: expect.objectContaining({ id: 'terminal-server' }) }))` 被调用。
  - `Retry triggers reconnect`：mockResolvedValue Retry 文案 → `connect` 被再次调用。
  - `auth errors stop auto-reconnect`：仿照现有 `stops retrying immediately when host key verification fails` 用例，错误消息换成 auth 文案，断言只 connect 一次且 notice 含 `authentication failed`。
  - `isLikelyAuthenticationError` 纯函数正反例（含 `connect ECONNREFUSED` 为 false）。

### 4.18 其余测试文件

- **`test/tree/ServerTreeProvider.test.ts`**：新增
  - `expands the group when it is the only one`：单组 → `collapsibleState === TreeItemCollapsibleState.Expanded`；两组 → 均 `Collapsed`。
  - `marks connected servers with the server-connected context value`：`new ServerTreeItem(server(...), 'connected').contextValue === 'server-connected'`；无状态/`'disconnected'` 时为 `'server'`。
- **`test/config/keepAlive.test.ts`**（新）：服务器值 45 → 45；服务器值 0 → 0（设置 60 也不覆盖）；字段缺失 + 设置 60 → 60；字段缺失 + 设置返回非法（NaN/-1）→ 30；`configuration.get` 收到 `('keepAliveInterval', 30)`。
- **`test/extension/ConnectReuse.test.ts`**（新，套用 `McpInstallCommand.test.ts` 的 activate+registerCommand 捕获骨架）：
  - mock `../../src/webview/TerminalPanel`：`TerminalPanel` 为带 `open`/`reveal`/`disconnectByServerId`/`updateServer`/`disconnectAll`/`getActive` 静态 spy 的类。
  - `connect reuses an existing panel`：`reveal` mock 返回真值 → handler 执行后 `open` 未被调用。
  - `connect opens when no panel exists`：`reveal` 返回 undefined → `open` 调用一次。
  - `newTerminal always opens`：`reveal` 不被调用、`open` 调用一次。
  - `disconnect with a tree item disconnects that server's panels`：`disconnectByServerId` 以 server.id 调用。
- **`test/extension/TerminalSerializer.test.ts`**（新）：spy `vscode.window.registerWebviewPanelSerializer` 捕获 serializer；mock ConfigManager（activate 内部实例化，改走真实 ConfigManager + `globalState.get` 返回含目标 server 的列表，参考 `test/extension` 现有构造）或更简单：直接单测 `deserializeTerminalState` + 用捕获到的 serializer 传入 `state: { serverId: 'missing' }`，断言 `panel.dispose()` 被调用；`state: undefined` 同样 dispose。存在服务器的恢复路径已由 4.17 的 `restore` 用例覆盖，这里不重复起真实面板。
- **`test/extension/McpInstallCommand.test.ts`**（改）：新增用例——mock `ensureAtSeriesConfigForCurrentIde` 返回 `undefined`，`vi.spyOn(vscode.window, 'showWarningMessage')`：
  - 断言警告文案含检测到的宿主名与 `Kiro, Cursor, and Continue`；
  - mockResolvedValue 为 Copy 动作文案 → `vscode.env.clipboard.writeText` 收到含 `"AT Series"`、`hub.js`、`AT_SERIES_HOST_APP` 的 JSON；
  - uninstall 返回 undefined → 文案含 `No MCP config was removed`。
  - 纯函数用例：`formatMcpTargetNotDetectedMessage('continue', false)` 提到 workspace 与 `.continue/mcpServers`；`('vscode', true)` 提到 `vscode` 与三个 IDE；`buildManualMcpConfigSnippet('unknown', '/x/hub.js')` 的 env 为 `vscode`、args 为 `['/x/hub.js']`。
  - 注意 fixture 的 `env` 无 `clipboard` spy 能力：`vscode.env.clipboard.writeText` 需 `vi.spyOn(vscode.env.clipboard, 'writeText')`。
- **`test/extension/activation.base.test.ts`**（新，唯一 `*.base.test.ts`，只被 `vitest.base.config.ts` 收集）：套用 McpInstallCommand 骨架（同样 mock BridgeServer / hubSync / McpConfigInstaller 三模块 + registerCommand 捕获），`activate(context)` 后断言：`syncPackagedHub` 未调用、`ensureAtSeriesConfigForCurrentIde` 未调用、`registeredCommands` 不含 `sshManager.installMcpConfig` / `sshManager.uninstallAtSeriesMcpConfig`、含 `sshManager.connect` 与 `sshManager.newTerminal`；`deactivate()` 不抛。
- **`test/docs/UsageCommandsDocs.test.ts`**（新）：

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const nls = JSON.parse(readFileSync('package.nls.json', 'utf8')) as Record<string, string>;
const usage = readFileSync('docs/usage.md', 'utf8');
const chineseUsage = readFileSync('docs/usage.zh-CN.md', 'utf8');

describe('usage docs list every contributed command', () => {
  const titles = Object.entries(nls)
    .filter(([key]) => /^atTerminal\.command\..+\.title$/.test(key))
    .map(([, title]) => title);

  it('reads a plausible number of command titles', () => {
    expect(titles.length).toBeGreaterThan(20);
  });

  it.each(titles)('documents "%s" in both usage guides', (title) => {
    expect(usage).toContain(title);
    expect(chineseUsage).toContain(title);
  });
});
```

  （落地前先跑一遍确认现存标题全部在 usage 里；缺的按 4.13/4.14 补文档，而不是放宽测试。）
- **`test/package.baseBundle.test.ts`**（改，可选加固）：追加断言 base bundle 不含本切片新增的 MCP-only 字符串：`expect(baseBundle).not.toContain('Copy Manual Config');`、`expect(mcpBundle).toContain('Copy Manual Config');`（该字符串只出现在 `if (MCP_ENABLED)` 块内，能验证 define 折叠仍有效）。

### 4.19 `docs/handoffs/_wiring-e.md`（E 必须产出的交接文件）

包含四节，标题固定：

1. **「SftpTreeProvider：none 状态返回空数组以显示 viewsWelcome」** —— 给集成者的补丁（C 拥有 `src/tree/SftpTreeProvider.ts` 与 `test/tree/SftpTreeProvider.test.ts`）：

```ts
// src/tree/SftpTreeProvider.ts — getChildren 内
if (state.kind === 'none') {
  return [];
}
```

   同时删除该文件对 `SftpPlaceholderTreeItem` 的 import 若因此未用（类本身保留在 SftpTreeItems.ts，不删）；`t('No active SSH terminal')` 在该 provider 中不再使用。配套测试补丁：`test/tree/SftpTreeProvider.test.ts` 中断言 `getChildren()`（none 状态）返回 `[]`，替换现有「placeholder」断言。`disconnected` 快照分支行为不变。
2. **「ServerFormPanel：keepAlive 表单默认值改读设置」** —— 补丁：`src/webview/ServerFormPanel.ts` 中两处 `?? 30` / `value="${server?.keepAliveInterval ?? 30}"` 的 30 改为 `resolveKeepAliveInterval({}, vscode.workspace.getConfiguration('sshManager'))` 计算出的默认值（在 open/render 处求值一次后传入模板）。若与 B/C 的表单改动冲突，以先合入者为准、后合者手工套用。
3. **「认证分类器接线（B 合入后）」** —— 若 B 的 `src/ssh` 导出了错误分类器（形如 `classifySshError(error).code === 'auth-failed'`），把 `TerminalPanel.ts` 的 `isLikelyAuthenticationError` 内部实现改为委托分类器，函数与调用点保持不变；B 未合入则维持字符串匹配版。
4. **「l10n zh-cn 新增条目（与 A 并集合并）」** —— §6.2 的完整键值表。

---

## 5. 与 A–D 的集成顺序 / wiring 应用

- 树里现存的 `_wiring-agent.md`、`_wiring-sftp.md`、`_wiring-ssh.md`、`_wiring-terminal.md`、`_wiring-ux.md` 是**上一轮**的交接文件，其内容已经落在基线里（例如 `promptChangedHostKey`、`showErrorWithActions`、`onDidRemoveContext` 清理都已存在）。**不要重复应用**；只把它们当历史背景读。
- 本轮 E 是最后合入的切片，集成者（通常就是 E 的实现 Agent 兼任）需按 **A → B → C → D** 顺序应用各切片新产出的 wiring 文件（命名预期 `docs/handoffs/_wiring-a.md` … `_wiring-d.md`；若某切片沿用旧命名，以文件头声明的切片名为准）。预期出现的 snippet 标题（按 IMPLEMENTATION-PLAN 的必交付推断，实际以各文件为准）：
  - `_wiring-a.md`：「l10n zh-cn 全量新增条目」（A 拥有 bundle，可能直接落地而非 wiring）；A 不改 extension.ts，预计无代码补丁。
  - `_wiring-b.md`：「终端/转发连接路径注入缺失口令与 passphrase 的 InputBox provider」（改 `extension.ts` 构造 SshSession / buildSshConnectionHandle 的 provider 包装）；「ssh 连接错误分类器的调用点替换」（与 E 的 `isLikelyAuthenticationError` 对接，见 4.19-3）；「SshConfigImport ProxyCommand 警告透传到 importSshConfig 提示」。
  - `_wiring-c.md`：「SftpManager 会话工厂注入 keyboard-interactive prompt」（改 `extension.ts` 中 `new SftpSession(terminal.server, configManager, hostKeyVerifier, { allowSudoFallback: true })` 的调用，追加 prompt 参数）；「预览路径静默化对 sftp.openPreview 处理器的参数变更」。
  - `_wiring-d.md`：预计无 extension.ts 补丁（D 的改动集中在 src/agent、src/mcp、skills）；若 `SftpAgentService` / `AgentToolService` 构造签名变化，会以「MCP 块构造参数更新」snippet 出现。
- 应用每份 wiring 后立刻 `npx tsc --noEmit && npx vitest run`，再应用下一份。
- E 自己的跨界改动统一走 `docs/handoffs/_wiring-e.md`（见 4.19），其中 SftpTreeProvider 补丁在 C 合入**之后**由集成者打（C 也在改同一文件的会话重建逻辑，避免冲突）。
- 冲突原则：`extension.ts` 由 E 所有，其他切片对它只有 wiring；照单全收后如与 E 的新处理器（connect/disconnect/newTerminal/serializer）重叠，以本文 §4.3 的形态为准，把 wiring 的增量融进来。

---

## 6. nls / l10n 键清单

### 6.1 `package.nls.json` / `package.nls.zh-cn.json`（键集合两边必须一致）

新增：

| 键 | en | zh-cn |
| --- | --- | --- |
| `atTerminal.command.newTerminal.title` | `SSH: New Terminal` | `SSH: 新建终端` |

修改（键不变，仅值）：

| 键 | en 新值 | zh-cn 新值 |
| --- | --- | --- |
| `atTerminal.config.idleDisconnectMinutes.description` | `Disconnect SSH terminals after this many minutes with no input and no output. Set 0 to disable.` | `SSH 终端在既无输入也无输出超过该分钟数后自动断开。设为 0 表示关闭。` |
| `atTerminal.config.keepAliveInterval.description` | `Default SSH keep-alive interval in seconds for new and imported servers; also the fallback when a server has no value. The per-server value wins. Set 0 to disable.` | `新建/导入服务器的 SSH keep-alive 默认间隔（秒），服务器未设置时也作为兜底；每服务器的表单值优先。设为 0 表示关闭。` |
| `atTerminal.viewsWelcome.sftpFiles` | `No SFTP connection yet.\n[Connect to a Server](command:sshManager.connect)\nConnect from the Servers view, then browse and manage remote files here.` | `还没有 SFTP 连接。\n[连接服务器](command:sshManager.connect)\n从“服务器”视图连接后，即可在此浏览和管理远程文件。` |

### 6.2 `l10n/bundle.l10n.zh-cn.json` 新增条目（E 直接追加 + 复制进 `_wiring-e.md`；按现有字母序插入；占位符必须一字不差）

| English source（`t()` 字面量） | 建议中文 |
| --- | --- |
| `A saved SSH terminal could not be restored because its server no longer exists.` | `无法恢复已保存的 SSH 终端：对应的服务器已不存在。` |
| `Add Server` | 已存在（`添加服务器`），无需新增 |
| `Authentication to {label} failed: {message}` | `连接 {label} 时身份验证失败：{message}` |
| `Automatic MCP config supports Kiro, Cursor, and Continue (with an open workspace). Detected IDE: {hostApp}. Use "Copy Manual Config" to configure any other MCP client.` | `自动写入 MCP 配置目前支持 Kiro、Cursor 和 Continue（需要打开工作区）。检测到的 IDE：{hostApp}。其他 MCP 客户端请点击“复制手动配置”自行配置。` |
| `Copy Manual Config` | `复制手动配置` |
| `Edit Server` | `编辑服务器` |
| `Manual MCP config copied to the clipboard.` | `手动 MCP 配置已复制到剪贴板。` |
| `No MCP config was removed. Automatic MCP config supports Kiro, Cursor, and Continue. Detected IDE: {hostApp}.` | `未移除任何 MCP 配置。自动管理仅支持 Kiro、Cursor 和 Continue。检测到的 IDE：{hostApp}。` |
| `No SSH servers configured yet. Add one to get started.` | `还没有配置 SSH 服务器。先添加一台开始使用。` |
| `No SSH terminal is open for {label}.` | `{label} 当前没有打开的 SSH 终端。` |
| `Open a workspace folder so the Continue MCP config can be written to .continue/mcpServers/at-terminal.yaml.` | `请先打开一个工作区文件夹，Continue 的 MCP 配置才能写入 .continue/mcpServers/at-terminal.yaml。` |
| `Open Usage Guide` | `打开使用教程` |
| `Reconnect stopped: authentication failed. Edit the server credentials and retry.` | `已停止重连：身份验证失败。请编辑服务器凭据后重试。` |
| `Restored session. Press Reconnect to connect.` | `会话已恢复。点击“重新连接”以连接。` |
| `Retry` | `重试` |

（`Reconnect`、`Connection disconnected`、`No active SSH terminal`、`Disconnected after {minutes} minute(s) of inactivity.` 等复用条目已在 bundle，勿重复。）

---

## 7. Acceptance（验收清单）

按序执行，全部满足才算完成：

1. `npx tsc --noEmit` 零错误。
2. `npx vitest run` 全绿（含既有 717+ 用例与本切片新增；`test/i18n/nls.test.ts` 尤其要绿——所有新 `t()` 字符串在 bundle 有译文）。
3. `npx vitest run --config vitest.base.config.ts` 全绿（`activation.base.test.ts` 在 `MCP_ENABLED=false` 下通过）。
4. 行为验收（对应目标）：
   - 树上单击已开终端的服务器：不新建 SSH 连接、原面板被 reveal；右键 New Terminal 新开面板；已连接项右键有 Disconnect，断开后面板保留且树图标变 `debug-disconnect`。
   - 树上下文菜单在 `server` 与 `server-connected` 两种 contextValue 下都能看到 Edit/Delete/Copy Host/Fingerprint/Forget/Forward 六项（when 子句已更新）。
   - `deserializeTerminalState` 对垃圾输入返回 undefined；恢复的面板初始即显示 Reconnect，未发生任何 `session.connect()`；服务器缺失时面板被 dispose 并出提示。
   - 空闲断开：输出活动能推迟断开、节流 5 秒、用户断开后不复活。
   - `sshManager.installMcpConfig` 在 ensure 返回 undefined 时给出宿主名 + 三 IDE + 两个动作；复制内容是合法 JSON，含 `AT Series`、hub.js 绝对路径、`AT_SERIES_HOST_APP`；Continue 无工作区时提示打开工作区。
   - `resolveKeepAliveInterval`：0 不被覆盖；缺失走设置；`importSshConfig` 新记录用设置值。
   - CI 文件无任何 `at-series-mcp-hub` sibling 步骤；`package` job 只在 `workflow_dispatch` 下运行；`@vscode/vsce` 在 devDependencies 且 lock 更新。
   - `docs/usage.md` / `docs/usage.zh-CN.md` 通过新 drift 测试（每个命令标题都出现）；`docs/features*.md` 的 diff 为空。
5. 本地（不进 CI 必跑）抽查一次 `npm run package:base && npm run package:mcp` 成功产出两个 VSIX（时间紧可跳过，但要在 PR 描述里说明是否跑过）。
6. 产出 `docs/handoffs/_wiring-e.md`（4.19 的四节齐全）。
7. 提交信息按逻辑分块（面板复用/序列化、空闲输出、MCP 提示、keepAlive、CI、docs 至少各一 commit），推送 `cursor/slice-e-ux-release-11f8`。

---

## 8. Edge cases（实现时必须考虑）

- **同服务器多面板**：reveal 优先连接面板；全部未连接时选最近创建的；`disconnectByServerId` 遍历全部。禁止用 `Map<serverId, panel>` 顶掉旧面板。
- **面板 dispose 与 Set**：`onDidDispose` 已删注册表项；`reveal`/`findByServerId` 永不返回已 dispose 面板。`disconnect()` 不删——这是「复用未连接面板」语义的载体。
- **命令面板路径**：`sshManager.connect` 无 item 时走 pickServer，复用逻辑同样生效（选中已开面板的服务器 → reveal）。
- **恢复时序**：不依赖向刚恢复的 webview postMessage（可能丢）；恢复态直接烙进 HTML（disconnected header + 可见 Reconnect）。`deserializeWebviewPanel` 由 VS Code 在标签首次可见时懒调用，逻辑不得假设激活即恢复。
- **恢复后的信任链**：`userDisconnected = true` 保证 `scheduleAutoReconnect` 永不触发；Reconnect 走 `reconnect()` → 新 SshSession → hostKeyVerifier / KI prompt / 凭据——与新建连接完全同链。主机密钥变更仍然阻断。
- **serverId 注入 HTML**：`data-server-id` 必须过 `escapeAttr`（id 目前是 UUID，但不要依赖这一点）。
- **空闲节流与假时钟**：`Date.now()` 在 vitest fake timers 下随 `advanceTimersByTime` 前进（默认 toFake 含 Date），测试按此写。
- **输出节流不等于不重置**：`scheduleIdleDisconnect` 本身 clear+set，节流只是限制频率；`idleDisconnectMinutes <= 0` 时 `noteOutputActivity` 直接返回，不做无谓的 Date.now。
- **认证错误弹窗只弹给用户动作**：`connect()`（首次）与 `reconnect()`（含自动重连的最后一跳）各弹一次即可；`offerAuthFailureActions` 里 `this.disposed` 守卫防止面板关闭后按钮回调触发命令。
- **`editServer` 传参形状**：处理器只读 `item?.server`，传 `{ server }` 结构化对象即可，不需要真的 `ServerTreeItem` 实例。
- **keepAlive 0**：0 = 用户显式关闭，任何层都不得覆盖成设置值。
- **MCP 提示只在显式命令**：激活期 ensure 失败/undefined 保持现状（静默或既有 Repair 流程），不给启动加弹窗。
- **base 构建**：serializer 注册、newTerminal、面板复用全部在 MCP 块外，base 变体必须同样工作；`Copy Manual Config` 等字符串只在 MCP 块内（baseBundle 测试可验证折叠）。
- **when 子句改动的回归**：`package.variants.test.ts` 里两处 `objectContaining({ when: ... })` 必须同步更新，否则先红。
- **nls 键守恒**：`nls.test.ts` 要求 en/zh 键集合相等、每个键被 base 或 mcp manifest 使用——`newTerminal` 命令必须同时进三个 manifest。
- **usage drift 测试**：4.18 的 `it.each(titles)` 会连 SFTP/资产/MCP 全部标题一起断言；改文档时保持既有列表完整，别只加新命令。
- **CI audit**：`npm audit --omit=dev` 现在跑在根目录；`@vscode/vsce` 是 devDependency，不影响 audit 范围。
- **`.vsix` 体积阈值**：`package` job 的 100 KB 下限只是防空产物，不做上限断言（真实 VSIX 若干 MB）。

---

## 9. Out of scope（重申）

- walkthroughs contribution；publisher 从 `local` 迁移；`@vscode/test-electron` 完整 harness（devDependency 留着即可）。
- vscode 宿主 `mcp.json` 自动写入器（上游 hub 的 installer target 先行，另开切片）。
- 端口转发多条/断线提示/状态栏；GBK/Big5 输入侧编码与 SFTP 文件名编码。
- `docs/features.md` / `docs/features.zh-CN.md` 的任何改动（A 所有，含 Limited-trust 表）。
- `SftpManager` 死会话重建、KI 注入（C）；ssh 凭据 InputBox、错误分类器本体（B）；agent 超时/审计（D）。
- 递归目录删除 MCP 工具、终端/agent/SFTP 共享连接等产品边界项（见 IMPLEMENTATION-PLAN 总则）。
