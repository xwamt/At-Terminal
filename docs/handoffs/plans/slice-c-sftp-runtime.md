# Slice C — SFTP 运行时(2FA、死会话重建、拖拽冲突、预览降噪、编辑缓存 gitignore)

> 实现合同。先读 `docs/handoffs/IMPLEMENTATION-PLAN.md` 的操作规程,再读本文。实现基线是
> `cursor/implement-optimizations-11f8`(`27deea6` 或其后的分支 HEAD),**不是** `main`;工作分支建议
> `cursor/slice-c-sftp-runtime-11f8`。本文行号以基线树为准,若漂移以符号名为准。

| 项 | 值 |
| --- | --- |
| 文件所有权 | `src/sftp/**`(**除** `TransferService.ts`),`src/tree/Sftp*.ts`,`test/sftp/**`,`test/tree/Sftp*.ts` |
| 明确不拥有 | `src/extension.ts`,`src/agent/**`,`src/ssh/**`,`l10n/**`,`package.json` |
| 越界补丁去处 | `docs/handoffs/_wiring-c.md`(本切片交付物之一,内容见配套文件) |
| 验收命令 | `npx tsc --noEmit`;`npx vitest run test/sftp test/tree`;最后全量 `npx vitest run` |

一个例外须知:本切片会对共享测试夹具 `test-fixtures/vscode.ts` 做**一处纯新增**(`Uri.parse` 静态方法,
见 §F-7)。该文件不在任何切片的所有权清单里;新增静态方法不可能破坏其他切片的既有测试,属于允许的
最小越界,须在 commit message 和 `_wiring-c.md` 中声明。

---

## 1. Goal / Non-goals

### Goal(必须交付,与 IMPLEMENTATION-PLAN「切片 C 必须交付」一致)

1. **用户驱动的 SFTP 会话可注入 keyboard-interactive prompt**:`SftpSession` 构造选项新增
   `keyboardInteractive?: KeyboardInteractivePrompt`;用户会话(SFTP 树/上传/下载/编辑)经 wiring 注入
   VS Code InputBox 实现;agent/后台会话保持 `undefined`,行为仍是 fail-fast。
2. **死会话检测与重建**:ssh2 客户端 `close`/`end`/`error` 之后 `SftpSession.isConnected()` 返回
   `false`;`SftpManager.ensureSession` 发现缓存会话已死时销毁并重建,而不是永远复用。
3. **拖拽上传与 Upload 命令同语义**:拖入目录走 `uploadDirectory` 递归;拖入已存在路径弹
   Overwrite / Overwrite All / Skip 模态对话框;冲突循环抽成切片 C 拥有的可复用帮助函数,`extension.ts`
   的 Upload 命令日后可切换过来(切换补丁放 `_wiring-c.md`)。
4. **预览降噪 + 预览标签页**:单击预览的下载不再弹完整通知和成功 toast(仅状态栏 Window 进度),
   打开时使用 `{ preview: true }` 复用预览标签页。
5. **编辑缓存写 `.gitignore`**:`resolveEditStorageUri` 指向工作区 `.ssh-terminal-manager` 时,首次(以及
   每次)打开远程编辑都确保该目录下存在内容为 `*` 的 `.gitignore`,防止 "Keep Local Copy" 留下的
   密钥/配置进入用户仓库。
6. **(可选,零成本时才做)** symlink 删除确认不按目标目录内容计数——该修改落在 `extension.ts`,
   本切片**只交付 wiring 片段**,不改产品代码。

### Non-goals(做了即越界)

- 不改 `src/sftp/TransferService.ts`(切片 A 拥有)。它现有的 `notification?: 'full' | 'quiet'` 已够用,
  本切片只透传。
- 不改 `src/extension.ts`、`src/agent/**`(含 `SftpAgentService.terminalSessions` 的同类死会话问题——
  只在 wiring 里提醒 D/集成者)、`src/ssh/**`(`KeyboardInteractive.ts`、
  `VscodeKeyboardInteractivePrompt.ts`、`SshConnectionConfig.ts` 均只 import,不编辑)。
- 不做传输取消、断点续传、`chmod`、ignore globs、不开终端的独立浏览(见 §10 Out of scope)。
- 不新增任何 MCP 工具,不触碰 `sftp_delete` 语义。

---

## 2. Current(现状,逐条对应 Goal)

### 2.1 keyboard-interactive:SFTP 恒定 fail-fast

`src/sftp/SftpSession.ts` 的 `connect()`(基线 57–86 行)当前是:

```ts
async connect(): Promise<void> {
  const client = new (await getSsh2()).Client();
  this.client = client;
  const handle = await buildSshConnectionHandle(this.server, this.passwords, this.hostKeyVerifier);
  this.connectionHandle = handle;

  try {
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      attachKeyboardInteractive(client, undefined, reject);
      client.connect(handle.config);
    });

    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error) { reject(error); return; }
        resolve(sftp);
      });
    });
  } catch (error) {
    client.end();
    handle.dispose();
    this.connectionHandle = undefined;
    throw error;
  }
}
```

两个硬编码点:

- `attachKeyboardInteractive(client, undefined, reject)` —— prompt 恒为 `undefined`,服务器一发
  keyboard-interactive 请求就中止连接(`KeyboardInteractive.ts` 的注释行为)。终端路径早已支持 2FA
  (`extension.ts` 的本地端口转发命令给 `buildSshConnectionHandle` 传了
  `{ keyboardInteractivePrompt: createVscodeKeyboardInteractivePrompt() }`),SFTP 树/上传/编辑没有。
- `buildSshConnectionHandle(...)` 没传第 4 个参数 `SshConnectOptions`,所以**跳板机**握手时的
  keyboard-interactive 同样无 prompt 可用(`SshConnectionConfig.ts` 内部
  `attachKeyboardInteractive(jumpClient, options.keyboardInteractivePrompt, reject)`)。

`SftpSessionOptions`(36–43 行)目前只有 `allowSudoFallback: boolean`。

`extension.ts` 里两处工厂(**不拥有**,仅照抄现状供 wiring 对照):

```ts
// extension.ts 80–85 行,用户驱动:
const sftpManager = new SftpManager({
  // The SFTP view is driven by the user, so a denied write may retry under sudo.
  createSession: (terminal) =>
    new SftpSession(terminal.server, configManager, hostKeyVerifier, { allowSudoFallback: true }),
  reporter: new VscodeTransferReporter()
});

// extension.ts 181–190 行,agent 后台:
sftpAgentService = new SftpAgentService({
  terminalContext,
  // Agent writes never escalate: ...
  createSession: (target) =>
    new SftpSession(target.server, configManager, hostKeyVerifier, { allowSudoFallback: false }),
  authorizer: sftpWriteAuthorizer,
  resolveBackgroundServer: (serverId) => configManager.getServer(serverId),
  audit: agentAuditLog
});
```

### 2.2 死会话:`isConnected()` 永远为真

`SftpSession.isConnected()`(88–90 行)是 `Boolean(this.client && this.sftp)`;没有任何代码在 ssh2
客户端 `close`/`end`/`error` 时清这两个字段,所以连接断开后它仍返回 `true`。
`SftpManager.ensureSession`(341–392 行)开头 `if (connection.session) { return connection.session; }`
—— 缓存命中即返回,死会话被永久复用,文件视图从此每次操作都报底层错误,直到用户关掉终端。
另外,连接成功后 `client.once('error', reject)` 只消费第一次 error;ready 之后第二次 `error` 事件在
EventEmitter 上无监听器,会直接抛到扩展宿主。

`SftpAgentService.terminalSessions`(agent 侧,**不拥有**)有同构问题:`ensureTerminalSession` 缓存
promise 直到终端关闭,不检查存活。本切片不碰,见 wiring §W-5。

### 2.3 拖拽:裸 `uploadFile`,无目录、无冲突

`SftpDragAndDropController.handleDrop`(39–58 行)对每个拖入 URI 直接
`manager.uploadFile(localUri.fsPath, joinRemotePath(targetPath, localUploadFileName(...)))`:

- 拖文件夹:`uploadFile` → `fastPut` 对目录直接失败,用户看到生错误 toast;
- 拖已存在文件:`SftpConflictError` 从 `handleDrop` 抛出,VS Code 只写日志,配套的 failure toast 也被
  `TransferService` 对冲突刻意抑制(见 `TransferService.runWithReporter` 注释),用户什么都看不到;
- 不过滤 URI scheme,非 `file:` 的拖拽源会得到无意义的 `fsPath`;
- 上传完不刷新树。

对照 `extension.ts` 的 `sshManager.sftp.upload` 命令(625–672 行,**不拥有**,语义基准):

```ts
const state = sftpManager.getState();
const targetDirectory = getTargetDirectory(item, state.kind === 'active' ? state.rootPath : '.');
let overwriteAll = false;
for (const file of files) {
  const remotePath = joinRemotePath(targetDirectory, localUploadFileName(file.fsPath));
  const localStat = await stat(file.fsPath);
  const upload = async (overwrite: boolean) => {
    if (localStat.isDirectory()) {
      await sftpManager.uploadDirectory(file.fsPath, remotePath, undefined, { overwrite });
      return;
    }
    await sftpManager.uploadFile(file.fsPath, remotePath, undefined, { overwrite });
  };
  try {
    await upload(overwriteAll);
  } catch (error) {
    if (!isSftpConflictError(error)) { throw error; }
    const overwrite = t('Overwrite');
    const overwriteEverything = t('Overwrite All');
    const skip = t('Skip');
    const choice = await vscode.window.showWarningMessage(error.message, { modal: true }, overwrite, overwriteEverything, skip);
    if (choice === overwrite || choice === overwriteEverything) {
      overwriteAll = choice === overwriteEverything;
      await upload(true);
    }
  }
}
sftpTreeProvider.refresh(item instanceof SftpDirectoryTreeItem ? item : undefined);
```

要点:目录分支、`overwriteAll` 跨条目持续、Esc/Skip 静默跳过、非冲突错误抛出终止整个循环。

### 2.4 预览:完整通知 + `preview: false`

- `SftpManager.downloadFile`(283–289 行)固定以 `'full'` 通知跑 `runConnected`(签名无 options 参数),
  每次单击预览 = 一条 Notification 进度 + 一条 "Download {path} completed." toast。
- `SftpPreview.openRemotePreviewFile`(65–78 行)最后
  `await options.openUri(readonlyUri, { preview: false });` —— 每个文件占一个常驻标签页,连点十个文件
  堆十个 tab。
- `TransferService.TransferRunOptions.notification?: 'full' | 'quiet'` 已存在且 `SftpManager.runConnected`
  已把 `options` 透传给 `transfers.run`(`QUIET` 常量即此用法);`'quiet'` 语义 = 无进度通知、无成功
  toast、失败仍 toast。**C 不拥有 TransferService,不新增第三种模式**;状态栏反馈由预览层自己包
  Window 进度实现(§F-5)。

### 2.5 编辑缓存目录裸奔

`resolveEditStorageUri`(SftpEditSessionManager.ts 81–87 行)在有 file 工作区时返回
`<workspace>/.ssh-terminal-manager`。`openRemoteFile`(114–151 行)里
`await mkdir(dirname(localUri.fsPath), { recursive: true })` 创建缓存目录,但从不写 `.gitignore`;
"Keep Local Copy" 保留的未同步副本(可能是密钥、生产配置)会被用户仓库的 git 捕获。

### 2.6 symlink 删除确认(可选项现状)

`extension.ts` 的 `sshManager.sftp.delete`(698–717 行,**不拥有**)对
`item.entry.type === 'directory' || item.entry.targetType === 'directory'` 统一走
`countDeletableEntries(path)`。对指向目录的 symlink,`countDeletableEntries` 经 `readdir` 追进目标目录
计数,确认框显示"将永久删除 N 个条目";而实际 `deleteEntry` 对 `type !== 'directory'` 走
`deleteFile`(unlink),只删链接本身。文案吓人且不准确。修复只涉及 `extension.ts`,见 wiring §W-6。

---

## 3. Target(目标行为汇总)

| # | 行为 | 触发者 |
| --- | --- | --- |
| T1 | 企业 OTP 服务器上,SFTP 树首次展开时弹 InputBox 要验证码(含跳板机握手),取消则连接失败且下次操作重新弹 | 用户 |
| T2 | agent/后台 SFTP 遇 keyboard-interactive 仍立即失败,错误信息不变 | agent |
| T3 | 网络闪断/服务器踢线后,下一次 SFTP 操作自动建新会话,无需关终端 | 用户 |
| T4 | ready 之后的 ssh2 `error` 事件不再可能抛到扩展宿主 | 运行时 |
| T5 | 拖文件夹进 SFTP 树 = 递归上传;拖已存在路径 = Overwrite / Overwrite All / Skip 模态;拖完子树刷新(wiring 后) | 用户 |
| T6 | 单击预览:状态栏短进度,无 Notification、无成功 toast(quiet 部分需 wiring),标签页斜体 preview 复用 | 用户 |
| T7 | 首次远程编辑后 `<workspace>/.ssh-terminal-manager/.gitignore` 存在且内容 `*`;用户自定义的同名文件不被覆盖 | 用户 |

---

## 4. File-by-file(逐文件改动,签名穷尽)

### F-1 `src/sftp/SftpSession.ts`

**新增 import**(type-only,不产生运行时依赖):

```ts
import { attachKeyboardInteractive, type KeyboardInteractivePrompt } from '../ssh/KeyboardInteractive';
```

(`attachKeyboardInteractive` 现已 import,只需把 type 并进来。)

**`SftpSessionOptions` 扩展**——完整目标形态:

```ts
export interface SftpSessionOptions {
  /**
   * Retry a permission-denied write through `sudo -n`. Only user-driven UI flows may enable
   * this: the escalation turns "the agent may write where the login user can" into "the agent
   * may write anywhere", and it does so without a second prompt.
   */
  allowSudoFallback: boolean;
  /**
   * Answers keyboard-interactive rounds (2FA codes, PAM) during connect, including the jump
   * host handshake. User-driven sessions inject the VS Code InputBox prompt; agent and
   * background sessions leave this undefined so an unanswerable request aborts the
   * connection immediately instead of popping UI nobody is watching.
   */
  keyboardInteractive?: KeyboardInteractivePrompt;
}
```

构造函数签名**不变**(第 4 参仍是 `options: SftpSessionOptions`),所以既有调用点
`new SftpSession(server, passwords, hostKeyVerifier, { allowSudoFallback: true })` 无需改动即编译通过
——这是 wiring 可以延迟合入的关键。

**新增私有字段**:

```ts
/** Set once the ssh2 client reports close/end/error after a successful connect. */
private disconnected = false;
```

**`connect()` 三处改动**(其余保持原样):

1. 把 prompt 透传给跳板机握手:

```ts
const handle = await buildSshConnectionHandle(this.server, this.passwords, this.hostKeyVerifier, {
  keyboardInteractivePrompt: this.options.keyboardInteractive
});
```

2. 把 prompt 透传给目标机握手:

```ts
attachKeyboardInteractive(client, this.options.keyboardInteractive, reject);
```

3. 在 `this.sftp = await ...` 成功之后(仍在 `try` 内、`catch` 之前)注册存活监听:

```ts
const markDisconnected = (): void => {
  this.disconnected = true;
};
// 'error' must keep a listener after the connect race settles: ssh2's Client is an
// EventEmitter, and an 'error' with no listener would crash the extension host. The
// once('error', reject) above is consumed by (or after) the first error; this persistent
// listener both marks the session dead and absorbs any later error events.
client.on('close', markDisconnected);
client.on('end', markDisconnected);
client.on('error', markDisconnected);
```

不监听 `SFTPWrapper` 自己的 channel `close`(通道单独关闭而连接仍活是罕见路径;下一次操作的错误会
浮出,随后通常伴随 client close)。在代码注释里写明这是有意取舍。

**`isConnected()`**:

```ts
isConnected(): boolean {
  return Boolean(this.client && this.sftp) && !this.disconnected;
}
```

**`dispose()`** 第一行加 `this.disconnected = true;`(幂等;`client.end()` 触发的 `close` 事件再标一次
无害)。其余不变。

`connect()` 每实例只会被 `SftpManager`/`SftpAgentService` 调用一次(死了就换新实例),不需要在
`connect()` 开头复位 `disconnected`;如担心误用可加 `this.disconnected = false;` 在函数首行,无副作用。

### F-2 `src/sftp/SftpManager.ts`

**`SftpSessionLike` 接口新增一行**(接口内其余成员不动):

```ts
export interface SftpSessionLike {
  connect(): Promise<void>;
  isConnected(): boolean;
  // ... 其余既有成员不变 ...
}
```

`SftpSession` 已实现该方法,`SftpAgentService` 的 `AgentSftpSession` 类型不受影响(它有自己的接口)。
所有 `test/sftp/SftpManager.test.ts` 的 `sessionStub` 需补 `isConnected: vi.fn(() => true)`(§6)。

**`ensureSession` 开头的缓存命中分支替换**。现状:

```ts
if (connection.session) {
  return connection.session;
}
if (connection.connectingSessionPromise) {
  return await connection.connectingSessionPromise;
}
```

目标:

```ts
if (connection.session) {
  if (connection.session.isConnected()) {
    return connection.session;
  }
  // The ssh2 client died behind our back (network drop, server kick). Drop the corpse and
  // fall through to create a fresh session; rootPath, snapshot and listing cache stay --
  // they describe the filesystem, not the transport.
  const deadSession = connection.session;
  connection.session = undefined;
  deadSession.dispose();
}
if (connection.connectingSessionPromise) {
  return await connection.connectingSessionPromise;
}
```

`generation` **不**自增(那是"上下文换人"的失效机制,重建同一终端的会话不该触发它);
`connectingSessionPromise` 分支在死会话清理**之后**检查,保证并发的两个操作共享同一次重建。

**`downloadFile` 增加第 4 参**(唯一的签名变化;`TransferRunOptions` 已在本文件 import):

```ts
async downloadFile(
  remotePath: string,
  localPath: string,
  serverId?: string,
  options?: TransferRunOptions
): Promise<void> {
  await this.runConnected(
    t('Download {path}', { path: remotePath }),
    async (session, progress) => session.downloadFile(remotePath, localPath, progress),
    serverId,
    options
  );
}
```

默认 `'full'`,所以既有调用点(`extension.ts` 下载命令、`SftpEditSessionManager.openRemoteFile` 的
编辑首次下载、`SftpEditSftpClient` 结构类型)行为与编译均不变。预览走 quiet 由 wiring 把
`{ notification: 'quiet' }` 传进来(§W-3)。

本文件不需要其他改动(`uploadFile`/`uploadDirectory` 的签名已满足帮助函数的需要)。

### F-3 `src/sftp/uploadWithConflict.ts`(新文件,切片 C 拥有)

拖拽与 Upload 命令共用的冲突循环。完整导出面:

```ts
import { stat as statLocalPath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { t } from '../i18n/t';
import { joinRemotePath, safePreviewName } from './RemotePath';
import { isSftpConflictError, type SftpConflictError } from './SftpErrors';
import type { SftpUploadOptions } from './SftpSession';

/** 冲突对话框的三种出路;`undefined`(Esc 关闭对话框)等价于 `'skip'`。 */
export type SftpConflictChoice = 'overwrite' | 'overwrite-all' | 'skip';

export type UploadConflictResolver = (
  conflict: SftpConflictError
) => Promise<SftpConflictChoice | undefined>;

/**
 * 上传目标的结构子集。`SftpManager` 直接满足;测试用普通对象即可,不需要 vscode。
 */
export interface ConflictAwareUploadTarget {
  uploadFile(
    localPath: string,
    remotePath: string,
    serverId?: string,
    options?: SftpUploadOptions
  ): Promise<void>;
  uploadDirectory(
    localDir: string,
    remoteDir: string,
    serverId?: string,
    options?: SftpUploadOptions
  ): Promise<void>;
}

export interface UploadLocalPathsOptions {
  target: ConflictAwareUploadTarget;
  /** 本地绝对路径,按给定顺序逐个处理(文件与文件夹可混合)。 */
  localPaths: readonly string[];
  /** 远端目标目录;每个条目的远端路径 = joinRemotePath(remoteDir, localUploadFileName(localPath))。 */
  remoteDir: string;
  resolveConflict: UploadConflictResolver;
  serverId?: string;
  /** 测试注入点;默认 node:fs/promises 的 stat。 */
  statLocal?(localPath: string): Promise<{ isDirectory(): boolean }>;
}

export interface UploadLocalPathsResult {
  /** 实际写入(含覆盖)的远端路径,按完成顺序。 */
  uploaded: string[];
  /** 因 skip / Esc 未写入的远端路径。 */
  skipped: string[];
}

/** 从本地路径取上传文件名;兼容 Windows 与 POSIX 分隔符。自 SftpDragAndDropController 移入。 */
export function localUploadFileName(localPath: string): string {
  return localPath.split(/[\\/]/).filter(Boolean).pop() ?? safePreviewName(localPath);
}

export async function uploadLocalPathsWithConflictPrompt(
  options: UploadLocalPathsOptions
): Promise<UploadLocalPathsResult>;

/** VS Code 模态对话框适配器;按钮与 Upload 命令完全同款,消息用 conflict.message(已本地化)。 */
export function createVscodeUploadConflictResolver(): UploadConflictResolver;
```

`uploadLocalPathsWithConflictPrompt` 的算法,**必须**与 §2.3 引用的命令循环逐点等价:

1. `let overwriteAll = false;`,顺序遍历 `localPaths`(不并发——每个条目内部的目录递归已经有
   `DIRECTORY_TRANSFER_CONCURRENCY`,条目间并发会让多个模态对话框互相踩)。
2. 每个条目:`const remotePath = joinRemotePath(options.remoteDir, localUploadFileName(localPath));`
   `const stats = await (options.statLocal ?? statLocalPath)(localPath);`
3. 定义 `const upload = (overwrite: boolean) => stats.isDirectory() ? options.target.uploadDirectory(localPath, remotePath, options.serverId, { overwrite }) : options.target.uploadFile(localPath, remotePath, options.serverId, { overwrite });`
4. `await upload(overwriteAll)`;捕获错误:
   - `!isSftpConflictError(error)` → 原样 rethrow(终止整个批次,与命令一致;调用方负责展示)。
   - 冲突 → `const choice = await options.resolveConflict(error);`
     - `'overwrite'` → `await upload(true)`,记入 `uploaded`;
     - `'overwrite-all'` → `overwriteAll = true; await upload(true)`,记入 `uploaded`;
     - `'skip'` 或 `undefined` → 记入 `skipped`,继续下一条。
5. 无冲突成功的条目记入 `uploaded`。返回 `{ uploaded, skipped }`。

`createVscodeUploadConflictResolver` 实现:

```ts
export function createVscodeUploadConflictResolver(): UploadConflictResolver {
  return async (conflict) => {
    const overwrite = t('Overwrite');
    const overwriteEverything = t('Overwrite All');
    const skip = t('Skip');
    // conflict.message 已经是本地化的 "Remote path already exists: {path}"。
    const choice = await vscode.window.showWarningMessage(
      conflict.message,
      { modal: true },
      overwrite,
      overwriteEverything,
      skip
    );
    if (choice === overwrite) {
      return 'overwrite';
    }
    if (choice === overwriteEverything) {
      return 'overwrite-all';
    }
    return 'skip';
  };
}
```

语义备注(写进代码注释):对目录,`overwrite: true` 的含义是"允许合并进已存在的远端目录"
(`SftpSession.ensureRemoteDirectory` 容忍 already-exists),不是先删后传;同名远端**文件**挡路时
`mkdir` 的原始错误会浮出——与 Upload 命令现状一致,不额外处理。

三个 `t()` 字符串(`'Overwrite'`、`'Overwrite All'`、`'Skip'`)在 `l10n/bundle.l10n.zh-cn.json`
里已存在,**本文件不引入新 l10n key**。

### F-4 `src/sftp/SftpDragAndDropController.ts`

**移出/再导出**:`localUploadFileName` 的实现移到 `uploadWithConflict.ts`(F-3),这里保留
`export { localUploadFileName } from './uploadWithConflict';` —— `extension.ts` 与既有测试的 import
路径不变,不需要 wiring。(方向必须是 DnD → uploadWithConflict,反向会成环。)

`collectDraggedUris`、`resolveDropTargetPath` 保持原样。

**新增导出**(scheme 过滤,拖拽源可能是编辑器 tab、远程资源等非本地文件):

```ts
/** 只保留 file: scheme 的拖拽项并转成本地 fsPath;其余(untitled:, vscode-remote: 等)静默丢弃。 */
export function draggedLocalFsPaths(uris: readonly string[]): string[] {
  return uris
    .map((raw) => vscode.Uri.parse(raw))
    .filter((uri) => uri.scheme === 'file')
    .map((uri) => uri.fsPath);
}
```

**控制器改造**——完整目标形态:

```ts
import { formatError } from '../utils/errors';
import { t } from '../i18n/t';
import {
  createVscodeUploadConflictResolver,
  uploadLocalPathsWithConflictPrompt,
  type UploadConflictResolver
} from './uploadWithConflict';

export interface SftpDragAndDropControllerOptions {
  /** 拖拽落盘后刷新 SFTP 树;extension.ts 经 wiring 传 () => sftpTreeProvider.refresh()。 */
  refresh?(): void;
  /** 测试注入点;缺省用 VS Code 模态对话框。 */
  resolveConflict?: UploadConflictResolver;
}

export class SftpDragAndDropController implements vscode.TreeDragAndDropController<SftpTreeNode> {
  readonly dropMimeTypes = ['text/uri-list'];
  readonly dragMimeTypes: string[] = [];

  constructor(
    private readonly manager: SftpManager,
    private readonly options: SftpDragAndDropControllerOptions = {}
  ) {}

  async handleDrop(
    target: SftpTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const state = this.manager.getState();
    if (state.kind !== 'active') {
      // handleDrop 的 rejection 只进日志,用户看不到;必须自己 toast。
      void vscode.window.showErrorMessage(t('No connected SSH terminal is active.'));
      return;
    }
    const uris = await collectDraggedUris(dataTransfer);
    const localPaths = draggedLocalFsPaths(uris);
    if (localPaths.length === 0) {
      return;
    }
    const targetPath =
      target instanceof SftpDirectoryTreeItem || target instanceof SftpFileTreeItem
        ? resolveDropTargetPath(target, state.rootPath)
        : state.rootPath;
    try {
      await uploadLocalPathsWithConflictPrompt({
        target: this.manager,
        localPaths,
        remoteDir: targetPath,
        resolveConflict: this.options.resolveConflict ?? createVscodeUploadConflictResolver()
      });
    } catch (error) {
      void vscode.window.showErrorMessage(formatError(error));
    } finally {
      this.options.refresh?.();
    }
  }
}
```

行为差异说明(相对现状):`state !== 'active'` 从 throw 改为 toast + return(throw 用户不可见);
非冲突错误从静默 rejection 改为 error toast(与 `runSftpCommand` 同款);第二参构造为可选,
`new SftpDragAndDropController(sftpManager)` 仍编译,refresh 注入放 wiring(§W-4)。
"从 VS Code 资源管理器拖入"路径不变:explorer 拖拽给的是 `file:` URI,`draggedLocalFsPaths`
原样放行。`t('No connected SSH terminal is active.')` 已在 zh 包里(SftpManager 同句),无新 key。

### F-5 `src/sftp/SftpPreview.ts`

**`OpenRemotePreviewFileOptions` 扩展**:

```ts
export interface OpenRemotePreviewFileOptions {
  storageUri: vscode.Uri;
  remotePath: string;
  previewStore: SftpPreviewDocumentStore;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  openUri(uri: vscode.Uri, options?: vscode.TextDocumentShowOptions): Promise<void>;
  /**
   * 包装下载阶段的进度反馈;缺省实现用状态栏(ProgressLocation.Window)转圈,标题复用
   * 既有 l10n key 'Download {path}'。测试注入直通实现即可。
   */
  withProgress?<T>(title: string, job: () => Promise<T>): Promise<T>;
}
```

**`openRemotePreviewFile` 两处改动**:

```ts
import { t } from '../i18n/t';   // 新增 import

// 下载行替换:
const withProgress = options.withProgress ?? defaultWindowProgress;
await withProgress(t('Download {path}', { path: options.remotePath }), () =>
  options.downloadFile(options.remotePath, localPreviewUri.fsPath)
);

// 打开行替换(preview 标签页复用,连点多个文件只占一个斜体 tab):
await options.openUri(readonlyUri, { preview: true });
```

文件底部新增:

```ts
async function defaultWindowProgress<T>(title: string, job: () => Promise<T>): Promise<T> {
  return await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, job);
}
```

注意:`downloadFile` 回调本身是否安静取决于 `extension.ts` 是否传 `{ notification: 'quiet' }`
(wiring §W-3)。**wiring 合入前**的过渡状态 = Notification 进度 + Window 进度并存、仍有成功 toast,
但 `preview: true` 已生效;在 `_wiring-c.md` 里写明这个过渡状态,避免集成者误判为 bug。
`'Download {path}'` 是既有 key,无新增。

用户主动的 "Download" 命令(另存到本地)**保持 full 通知**——那是真实字节传输,成功 toast 有意义;
只有单击预览降噪。

### F-6 `src/sftp/SftpEditSessionManager.ts`

**新增 import**:`writeFile` 并入既有 `node:fs/promises` import;`join` 并入既有 `node:path` import
(现为 `import { dirname } from 'node:path';`)。

**新增导出**:

```ts
/** 编辑缓存目录的忽略规则:忽略一切。`!.gitignore` 无必要——目录整个不该入库。 */
export const EDIT_STORAGE_GITIGNORE_CONTENT = '*\n';

/**
 * 确保编辑缓存根目录存在且带一个忽略全部内容的 .gitignore。缓存可能落在用户工作区
 * (<workspace>/.ssh-terminal-manager),"Keep Local Copy" 留下的副本可能含密钥/生产配置,
 * 绝不能被用户仓库的 git 捕获。已存在的 .gitignore(用户自定义)保持原样不覆盖。
 * storage 落在 globalStorageUri(无工作区回退)时写入同样无害,不做区分。
 */
export async function ensureEditStorageGitignore(storageUri: vscode.Uri): Promise<void> {
  await mkdir(storageUri.fsPath, { recursive: true });
  try {
    // 'wx' = create-only:存在即抛 EEXIST,天然免 TOCTOU,也不会覆盖用户自己的规则。
    await writeFile(join(storageUri.fsPath, '.gitignore'), EDIT_STORAGE_GITIGNORE_CONTENT, {
      flag: 'wx'
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}
```

**`openRemoteFile` 调用点**——在既有 mkdir 之前插一行:

```ts
const localUri = createEditCacheUri(this.options.storageUri, serverId, remotePath);
await ensureEditStorageGitignore(this.options.storageUri);
await mkdir(dirname(localUri.fsPath), { recursive: true });
```

为什么在 `openRemoteFile` 而不是构造函数:构造函数在扩展激活时同步执行,会在**每个**打开的工作区
无条件创建 `.ssh-terminal-manager/`,哪怕用户从不用远程编辑;放在 `openRemoteFile` 则只在真正产生
缓存时落盘,且每次打开都补检("mkdir 已存在仍要 ensure gitignore" 的要求由此满足)。
`sshManager.sftp.newFile` 命令经 `createRemoteFileForEditing → openRemoteFile` 也走同一咽喉点,
无需第二处调用。

### F-7 `test-fixtures/vscode.ts`(共享夹具,纯新增,见文首例外声明)

`draggedLocalFsPaths` 用到 `vscode.Uri.parse`,夹具的 `Uri` 类目前只有 `file`/`joinPath`/`from`。
在 `Uri` 类中**新增**一个静态方法,不改任何既有成员:

```ts
static parse(value: string): Uri {
  const match = /^([a-zA-Z][\w+.-]*):(?:\/\/[^/]*)?([^?#]*)/.exec(value);
  const scheme = match?.[1] ?? 'file';
  const path = decodeURIComponent(match?.[2] ?? value);
  return new Uri(path, scheme, path);
}
```

测试统一用 POSIX 形态的 `file:///home/...` URI,避开 Windows 盘符的 fsPath 规范化差异
(真实 VS Code 的 `Uri.parse('file:///C:/x').fsPath === 'c:\\x'`,夹具不模拟)。

### F-8 `src/tree/SftpTreeItems.ts` / `src/tree/SftpTreeProvider.ts`

**无产品代码改动**。拖拽逻辑全部在 `src/sftp/` 内。列入所有权仅为测试文件(`test/tree/Sftp*.ts`)
在需要时可调整——本切片预计不需要动它们;若最终确实零改动,在 PR 描述里写明。

---

## 5. 并发与生命周期设计说明(实现时照此写注释)

- **死会话重建与在途连接**:`ensureSession` 先清死尸、再查 `connectingSessionPromise`。两个并发操作
  同时发现死会话时,第一个进入创建路径并设置 `connectingSessionPromise`,第二个 await 同一个 promise
  ——`createSession` 只会被调用一次。既有的 generation/invalidation 机制(切换终端、断开)完全不变。
- **在途操作不重试**:会话在 `listDirectory`/`fastGet` 进行中死掉,该操作以底层错误失败并由现有
  通知路径展示;不做自动重试(重试语义对写操作不安全)。用户下一次点击自然走重建。
- **KI 取消**:`createVscodeKeyboardInteractivePrompt` 对取消返回 `undefined`,
  `attachKeyboardInteractive` 以 "Keyboard-interactive authentication was cancelled." reject 并
  `client.end()`;`ensureSession` 的 `.catch` 分支 `session.dispose()` 且清空
  `connectingSessionPromise`,所以取消后不留半死缓存,下次操作重新连接、重新弹 prompt。
- **拖拽串行**:`uploadLocalPathsWithConflictPrompt` 条目间严格串行(模态对话框不可并发);条目内
  目录递归沿用 `DIRECTORY_TRANSFER_CONCURRENCY = 4`。
- **`overwriteAll` 的作用域**是一次 drop / 一次命令调用,不跨调用持久。

---

## 6. Tests(新增/修改清单;先写失败测试再改产品代码)

约定:全部 vitest,复用现有夹具风格(`vi.mock('ssh2', ...)`、`test-fixtures/vscode.ts` 别名、
`mkdtemp` 临时目录当隔离文件系统)。下面每条给出断言要点。

### 6.1 `test/sftp/SftpSession.test.ts`(修改)

现有 ssh2 Client mock(文件顶部 `vi.mock('ssh2', ...)`)必须补 `on`,并记录 handler 以便测试触发:

```ts
const client = {
  handlers: {} as Record<string, (...args: unknown[]) => void>,
  once: vi.fn((event: string, handler: () => void) => { client.handlers[event] = handler; return client; }),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    client.handlers[event] = handler;
    return client;
  }),
  // connect/end/forwardOut/sftp/exec 保持原样
};
```

新增用例:

1. **`passes the keyboard-interactive prompt to the ssh handshake`**:构造
   `new SftpSession(server('password'), passwords, hostKeyVerifier, { allowSudoFallback: true, keyboardInteractive: prompt })`,
   其中 `prompt = vi.fn(async () => ['123456'])`。`connect()` 后触发
   `client.handlers['keyboard-interactive']('name', 'instr', 'en', [{ prompt: 'Code:', echo: false }], finish)`,
   断言 `prompt` 被调用且 `finish` 收到 `['123456']`。
2. **`aborts keyboard-interactive when no prompt is configured`**(回归保护):不传
   `keyboardInteractive`,让 `connect` mock 不立即 ready,触发 keyboard-interactive 事件,断言 connect
   promise 以 `no interactive prompt is available` reject 且 `sshMocks.end` 被调用。
3. **`forwards the prompt to the jump host handshake`**:对 `SftpSession` 用
   `vi.spyOn`/`vi.mock('../../src/ssh/SshConnectionConfig')` 断言 `buildSshConnectionHandle` 第 4 参为
   `{ keyboardInteractivePrompt: <同一函数引用> }`;或沿用现有 jump-host 用例结构,断言 jump client 的
   `keyboard-interactive` handler 走注入 prompt。两种实现任选,前者更省事。
4. **`marks the session dead on client close/end/error`**(三个事件各一断言或参数化):`connect()` 成功
   → `isConnected() === true`;触发 `client.handlers['close']()` → `isConnected() === false`。`end`、
   `error`(带一个 Error 参数)同理;`error` 用例顺带断言不抛(监听器吞掉事件)。
5. **`dispose marks the session dead`**:`connect()` 后 `dispose()` → `isConnected() === false`。

### 6.2 `test/sftp/SftpManager.test.ts`(修改)

`sessionStub` 补默认 `isConnected: vi.fn(() => true)`。新增:

1. **`recreates the session after the cached one reports disconnected`**:`createSession` 返回
   `first`(`isConnected` 先 true 后 false 的 `mockReturnValueOnce` 序列或可变闭包)与 `second`;
   `ensureRoot()` 用 first;把 first 标死;`listDirectory('/home/deploy/fresh')`(避开缓存路径)→
   断言 `createSession` 调用 2 次、`first.dispose` 被调用、`second.connect` 被调用。
2. **`shares one reconnect between concurrent operations`**:first 标死后,`second.connect` 挂在
   deferred 上;并发发起 `stat(...)` 与 `readFile(...)`(选不走 listing cache 的操作);flush 后断言
   `createSession` 总计 2 次;resolve 后两操作都成功。
3. **`keeps rootPath across a session rebuild`**:`changeDirectory('/var/log')` 后标死重建,断言
   `getState()` 仍是 `{ kind: 'active', rootPath: '/var/log' }`(重建不重置人所在目录)。
4. **`downloadFile stays quiet when asked`**(notifications describe 内):
   `await manager.downloadFile('/etc/hosts', '/tmp/hosts', undefined, { notification: 'quiet' })` →
   `progressLabels === []`、`successes === []`;再配一个失败用例断言
   `failures === ['Download /etc/hosts failed.']`(quiet 不吞失败)。
5. 既有用例回归:默认(不传 options)`downloadFile` 仍产生 full 进度与成功 toast——现有
   `keeps progress and the success toast for real transfers` 补一条 download 断言即可。

### 6.3 `test/sftp/uploadWithConflict.test.ts`(新文件)

用纯对象 target(`uploadFile`/`uploadDirectory` 为 `vi.fn`)与注入 `statLocal`,不触真实 fs:

1. **文件冲突 → overwrite**:`uploadFile` 第一次抛 `new SftpConflictError('/srv/a.txt')`,resolver 返回
   `'overwrite'`;断言第二次调用带 `{ overwrite: true }`,结果 `uploaded === ['/srv/a.txt']`。
2. **overwrite-all 跨条目、跨文件/目录持续**:三个条目 `[fileA, dirB, fileC]`,fileA 冲突 →
   `'overwrite-all'`;断言 resolver 只被调用一次,dirB 走 `uploadDirectory(..., { overwrite: true })`,
   fileC 走 `uploadFile(..., { overwrite: true })`。
3. **skip 与 Esc**:resolver 依次返回 `'skip'`、`undefined`;断言对应条目只尝试一次、进入 `skipped`,
   后续条目继续处理。
4. **目录分支**:`statLocal` 返回 `isDirectory() === true` → 走 `uploadDirectory`,远端路径 =
   `joinRemotePath(remoteDir, basename)`。
5. **非冲突错误终止批次**:第二个条目抛 `new Error('EACCES')`;断言整体 rejects 携带该错误、第三个
   条目未被尝试、`uploaded` 只含第一条。
6. **`localUploadFileName`**:把现有 Windows/POSIX 两条用例从 DnD 测试移过来或双处保留(re-export
   保证两个 import 路径都工作)。
7. **resolver 消息**:断言传给 resolver 的就是原 `SftpConflictError` 实例(`conflict.path` 可用)。

### 6.4 `test/sftp/SftpDragAndDropController.test.ts`(修改)

保留既有 `collectDraggedUris` 用例;新增:

1. **`draggedLocalFsPaths filters non-file schemes`**:
   `['file:///home/a.txt', 'untitled:Untitled-1', 'vscode-remote://x/y']` → `['/home/a.txt']`
   (依赖 F-7 的 `Uri.parse`)。
2. **`handleDrop uploads a dropped directory recursively`**:manager 桩(只需
   `getState`/`uploadFile`/`uploadDirectory`),`dataTransfer` 为 `Map`,拖入一个 `mkdtemp` 真实临时
   目录的 `file://` URI(或注入式改为经 `uploadLocalPathsWithConflictPrompt` 的真实 stat);断言
   `uploadDirectory` 被调用、`uploadFile` 未被调用。
3. **`handleDrop resolves conflicts like the upload command`**:注入 `resolveConflict` 返回 `'skip'`,
   `uploadFile` 抛冲突;断言不重试、不 rejects(handleDrop 自己消化)。
4. **`handleDrop refreshes the tree after the drop`**:注入 `refresh` spy,断言 drop 后(含冲突 skip
   路径)被调用一次。
5. **`handleDrop tolerates an inactive state`**:`getState()` 返回 `{ kind: 'none' }` → 不抛,
   `uploadFile` 未被调用(可 spy `vscode.window.showErrorMessage`)。
6. **drop 到文件节点落到父目录**:target 为 `SftpFileTreeItem`(entry.path `/srv/dir/f.txt`)→
   上传远端路径以 `/srv/dir/` 开头(复用 `resolveDropTargetPath` 既有行为,防回归)。

### 6.5 `test/sftp/SftpPreview.test.ts`(修改)

1. 既有断言 `expect(opened).toEqual([[previewUri, { preview: false }]])` 改为 `{ preview: true }`。
2. **`wraps the preview download in the injected progress`**:传
   `withProgress: async (title, job) => { titles.push(title); return await job(); }`,断言 title 为
   `Download /srv/app/docker-compose.yml` 且下载确实发生。
3. **缺省 withProgress 走 Window 位置**:`vi.spyOn(vscode.window, 'withProgress')`,断言收到
   `{ location: vscode.ProgressLocation.Window, title: ... }`(夹具已含 `ProgressLocation.Window`)。

### 6.6 `test/sftp/SftpEditSessionManager.test.ts`(修改;临时目录即"假文件系统")

复用该文件既有的 manager 构造桩(sftp client 桩 + ui 桩):

1. **`writes an ignore-everything gitignore when the edit cache is created`**:`mkdtemp` 存储目录,
   `openRemoteFile('/etc/app.conf')` 后断言 `<storage>/.gitignore` 存在且内容为 `*\n`
   (与 `EDIT_STORAGE_GITIGNORE_CONTENT` 比)。
2. **`keeps a user-provided gitignore untouched`**:预先写入 `.gitignore` 内容 `node_modules\n`;
   `openRemoteFile` 后断言内容仍是 `node_modules\n`。
3. **`re-ensures the gitignore when the directory already exists`**:第一次 `openRemoteFile` 后删除
   `.gitignore`(目录保留),第二次打开另一个远程路径,断言文件重新出现。
4. **`ensureEditStorageGitignore` 单元用例**:目录不存在时自动 `mkdir -p`;`EEXIST` 之外的错误
   (例如把 storage 指向一个**文件**触发 `ENOTDIR`)原样上抛。

### 6.7 `test/tree/Sftp*.ts`

预计无改动;若 F-4 的类型调整波及,只做编译层面修补,不改行为断言。

### 6.8 回归口径

- `npx vitest run test/sftp test/tree` 全绿;
- 全量 `npx vitest run`:基线 717+ 用例全部保持绿。特别注意 `test/i18n/nls.test.ts`——本切片在 src
  里新引入的 `t()` 全部复用既有 key(§7),该测试**必须**在本分支就保持绿,不允许出现
  wiring-sftp 时代"等 key 落地前先红"的状态。

---

## 7. l10n keys

本切片 src 代码**零新增** l10n key,全部复用既有条目(实现时不得改写这些字符串的措辞,否则 drift):

| 复用 key(English 原文) | 使用处 |
| --- | --- |
| `Overwrite` / `Overwrite All` / `Skip` | `createVscodeUploadConflictResolver` |
| `Remote path already exists: {path}` | `SftpConflictError.message`(对话框正文,已有) |
| `No connected SSH terminal is active.` | `handleDrop` 非活动状态 toast |
| `Download {path}` | 预览 Window 进度标题、`SftpManager.downloadFile` label(已有) |

**仅 wiring 片段引入**的新 key(C 不拥有 `l10n/bundle.l10n.zh-cn.json`,由集成者随 §W-6 一起落):

```json
{
  "Delete remote symlink \"{path}\"? Only the link is deleted; the target is kept.":
    "删除远程符号链接“{path}”？仅删除链接本身，其指向的目标会保留。"
}
```

---

## 8. Wiring(不拥有文件的补丁,全部写入 `docs/handoffs/_wiring-c.md`)

实现 agent 需把配套的 `_wiring-c.md`(与本文同批交付,内容已备好)原样提交到工作分支的
`docs/handoffs/_wiring-c.md`。条目索引:

| # | 目标文件 | 内容 |
| --- | --- | --- |
| W-1 | `src/extension.ts` | 用户 `SftpManager` 工厂注入 `keyboardInteractive: createVscodeKeyboardInteractivePrompt()`(含照抄的现行 80–85 行);agent 工厂保持不注入 |
| W-2 | `src/extension.ts` | Upload 命令体替换为 `uploadLocalPathsWithConflictPrompt` 帮助函数(行为等价,可选采纳) |
| W-3 | `src/extension.ts` | 预览命令的 `downloadFile` 回调追加 `{ notification: 'quiet' }` |
| W-4 | `src/extension.ts` | `SftpDragAndDropController` 构造追加 `{ refresh: () => sftpTreeProvider.refresh() }` |
| W-5 | `src/agent/SftpAgentService.ts`(**告知 D/集成者,C 不改**) | `ensureTerminalSession` 应用相同的 `isConnected()` 检查 |
| W-6 | `src/extension.ts` + l10n(可选项) | symlink 删除确认不计数、改文案 |
| W-7 | 说明 | `test-fixtures/vscode.ts` 已由 C 追加 `Uri.parse`(纯新增)的知会 |

---

## 9. Acceptance(验收清单)与 Edge cases

### 验收

1. `npx tsc --noEmit` 干净;`npx vitest run` 全绿(含 §6 全部新用例与 `test/i18n/nls.test.ts`)。
2. **未合 wiring 时**(仅本切片代码):所有既有行为编译期与运行期兼容——`SftpSession` 不传新选项 =
   现状;`downloadFile` 三参调用 = 现状;DnD 单参构造 = 现状 + 冲突对话框 + 目录支持;预览已是
   `preview: true` + Window 进度(通知仍 full,属已记录的过渡状态)。
3. **合入 W-1 后**手工路径:对一台开 OTP 的服务器打开 SFTP 树 → 弹 InputBox(密码遮蔽),输入后列出
   目录;点取消 → 明确错误,再次展开重新弹。
4. 手工:连接后在服务器侧 `pkill -f sshd`(或断网重连)→ 终端自动重连后,SFTP 树刷新即可用,无需
   关闭终端;期间扩展宿主无 unhandled error。
5. 手工:从资源管理器同时拖 2 个文件 + 1 个文件夹到 SFTP 树的目录节点上:文件夹递归上传;与远端
   重名的文件弹 Overwrite/Overwrite All/Skip;选 Overwrite All 后不再弹;(W-4 后)子树自动刷新。
6. 手工:单击文件 → 状态栏短进度,无 Notification/成功 toast(W-3 后),标签页标题斜体且连续单击
   不同文件复用同一 tab;编辑与显式 Download 命令仍是完整通知。
7. 手工:远程编辑保存一次后,工作区出现 `.ssh-terminal-manager/.gitignore`(`*`),`git status` 不
   出现缓存文件。

### Edge cases(实现与测试都要覆盖或至少注释声明)

- **混合 drop(文件 + 文件夹)**:顺序处理;`overwrite-all` 同时作用于后续文件与目录;目录"覆盖"是
  合并语义(见 F-3 备注)。
- **drop 中途非冲突错误**:批次终止,已传条目保留,错误 toast 一次;不回滚(与 Upload 命令一致)。
- **KI 被取消 / InputBox 超时关闭**:连接失败一次、无缓存残留、下次重弹(§5)。多轮 KI(多个
  prompts)由 `createVscodeKeyboardInteractivePrompt` 逐字段收集,C 无需处理。
- **列目录中途会话断开**:当次 `listDirectory` 失败并 toast;`close` 事件标死;用户再点 → 重建。
  树在失败刷新后显示错误状态属 VS Code 既有行为,不做额外兜底。
- **正在连接时终端断开/切换**:既有 generation + invalidation 路径不变(有既有用例守着)。
- **拖入 symlink(本地)**:顶层项 `stat`(follow)按目标类型处理;目录递归内部的 symlink 仍被
  `walkLocalDirectory` 跳过(既有行为,不改)。
- **拖入非 `file:` URI**:静默忽略;全部被过滤时 handleDrop 直接返回,不弹任何 UI。
- **`.gitignore` 已被用户改写**:`wx` 标志保证不覆盖;删除后下次编辑自动补回。
- **storage 回退到 `globalStorageUri`**(无 file 工作区):gitignore 照写,无害(注释声明)。
- **quiet 下载失败**:`TransferService` quiet 模式仍 `notifyFailure`,预览失败可见——测试 6.2-4 覆盖。

---

## 10. Out of scope(本切片明确不做)

- 断点续传 / 传输取消 / 传输队列;`chmod`、`sftp_copy` 等新能力;
- 上传/下载 ignore globs(默认跳过 `.git`、`node_modules` 之类);
- 不先开终端的独立"浏览文件"入口(`SftpManager` 仍以 TerminalContext 为宿主);
- 目录**下载**的冲突提示(本轮只对齐上传方向);
- 在途操作断线自动重试;`SFTPWrapper` channel 级 close 监听;
- `SftpAgentService` / `TransferService` / `extension.ts` 的任何直接编辑;
- keepAlive、空闲断开、树单击复用面板(切片 E);凭据补齐与错误分类(切片 B)。
