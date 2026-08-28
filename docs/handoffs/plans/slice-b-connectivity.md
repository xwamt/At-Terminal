# 切片 B — connectivity（凭据补齐、错误分类、跳板/ProxyCommand）实现细则

本文是给实现 Agent 的**完整实施合同**。实现者只依据本文与基线源码工作，先读完 `docs/handoffs/IMPLEMENTATION-PLAN.md` 的总规程，再读本文。

| 项 | 值 |
| --- | --- |
| 实现基线 | `origin/cursor/implement-optimizations-11f8`（`27deea6` 或其后的该分支 HEAD），**禁止** checkout/commit/push `main` |
| 工作分支 | 按总合同从基线新建切片分支 |
| 文件所有权 | **拥有**：`src/ssh/**`、`src/config/schema.ts`（仅当分类器需要导出类型，本文结论：不需要改）、`src/utils/errors.ts`（仅当新增 `UserVisibleError` 子类，本文结论：不需要改）、`test/ssh/**`。**不拥有**：`src/extension.ts`、`src/sftp/**`、`src/webview/**`、`src/agent/**`、`l10n/**`、`test/ssh` 之外的任何测试 |
| 越界改动 | 一律写进 `docs/handoffs/_wiring-b.md`（本切片已随本文交付，实现完成后按实际情况校对更新），由集成者/拥有切片粘贴 |
| 验收命令 | `npx tsc --noEmit`、`npx vitest run`（已知例外见 §8） |
| 行号说明 | 本文引用的行号以 `27deea6` 为准，可能漂移；**以符号名为准** |
| ssh2 版本 | `ssh2@1.17.0`（本文所有错误消息子串均从该版本 `lib/` 逐条核对） |

---

## 0. 目标 / 非目标

### 目标

1. **凭据按需补齐 hook**：`buildSshConnectConfig` 支持可选的 `promptForSecret` 回调。缺失密码、加密私钥缺口令（passphrase）、存储口令错误时，交互式调用方（终端、连接测试）可以弹 InputBox 现场补齐；后台调用方（Agent SFTP、命令执行器）不传回调，行为保持 fail-fast。本切片只实现 hook 与检测助手，**不得**调用 `vscode.window`（那是 wiring）。
2. **连接错误分类器**：新模块 `src/ssh/SshErrorClassify.ts`，把 ssh2 / Node socket 的原始错误映射成稳定 `code` + `t()` 本地化、可执行（actionable）的消息。让用户能区分「密码错了」「主机不可达」「DNS 解析失败」「端口没开」「agent 套接字缺失」。
3. **跳板链拒绝**：`buildSshConnectionHandle` 目前对跳板机自身的 `jumpHostId` 做 `{ ...jumpHost, jumpHostId: undefined }` 静默压扁。改为：**若跳板机自身配置了跳板，抛出可分类、已本地化的错误**（"Nested jump hosts are not supported"）。本切片不做递归多跳。
4. **SSH config 导入的 `ProxyCommand`**：`SshConfigImport.ts` 的 `buildEntry` 目前完全忽略 `proxycommand`，把本应走代理的主机当直连导入。改为：**跳过该主机并输出警告**（skip + warn）。已有的多跳 `ProxyJump` 截断警告保留。
5. 本切片拥有的 ssh 文件里所有**用户可达**错误消息走 `t()`；新增英文源串 → 建议中文的清单放在 `docs/handoffs/_wiring-b.md`（bundle 由切片 A/集成者拥有）。

### 非目标（本切片明确不做）

- 不实现 `known_hosts` 导入、每主机多算法多把密钥（`HostKeyStore` 保持 `host:port` 一把，不动）。
- 不做 keyboard-interactive 的 prompt UI —— `src/ssh/VscodeKeyboardInteractivePrompt.ts` 已存在且够用；`KeyboardInteractive.ts` 需要的导出（`KeyboardInteractivePrompt`、`KeyboardInteractiveRequest`、`attachKeyboardInteractive`、`KeyboardInteractiveClient`）**已全部导出**，`SftpSession`（切片 C 要给它注入 prompt）不缺任何符号，本切片对该文件只做 §4.3 的错误分类改造。
- 不改 `src/extension.ts`、`src/webview/TerminalPanel.ts`、`src/webview/ServerFormPanel.ts`、`src/sftp/**`、`src/agent/**` —— 所有需要它们配合的调用点写成 `_wiring-b.md` 里的补丁片段。
- 不实现「把弹出的密码/口令存回 SecretStorage」—— hook 只返回值；是否保存、是否加 "保存密码" 勾选是 wiring/切片 E 的 UX 决策。
- 不做跳板递归（多跳）；不给表单加「嵌套跳板」预警 UI（表单不归本切片，只在 wiring 文件留 note）。
- 不动主机密钥信任语义：指纹变更**默认仍阻断**，`requireHostKeyVerifier` fail-closed 不变。
- 不把本地端口转发暴露给 Agent；不合并终端/agent/SFTP 连接（产品边界，总合同禁止）。

---

## 1. 现状（基线 `27deea6` 逐点核对）

### 1.1 `src/ssh/SshConnectionConfig.ts`

- `PasswordProvider`：`getPassword(id)` 必选，`getPassphrase?(id)` 可选。没有任何 prompt 机制。
- `buildSshConnectConfig(server, passwordProvider, hostKeyVerifier)`（3 参数，无 options）：
  - `authType === 'password'`：`getPassword` 返回 falsy 即 `throw new Error('Missing password. Edit the server configuration and enter a password.')`（第 97 行，普通 `Error`，未走 `t()`）。
  - `authType === 'agent'`：`resolveAgentSocket()`，无 `SSH_AUTH_SOCK` 且非 win32 时 `throw new Error('Missing SSH agent socket. Set the SSH_AUTH_SOCK environment variable or start an SSH agent.')`（第 71–73 行）。
  - `authType === 'privateKey'`：无 `privateKeyPath` 时 `throw new Error('Missing private key path.')`；读文件后 `passphrase = await passwordProvider.getPassphrase?.(server.id)`，`undefined` 则省略字段。**加密私钥 + 无口令**这一情况完全不在这里检测——错误要等到 ssh2 的 `client.connect()` 同步抛 `Cannot parse privateKey: …`（见 §3）。
- `buildSshConnectionHandle(server, provider, hostKeyVerifier, options)`：`options` 只有 `keyboardInteractivePrompt`。跳板路径第 144 行：`buildSshConnectConfig({ ...jumpHost, jumpHostId: undefined }, …)` —— **静默压扁**跳板机自身的跳板配置。跳板缺失时 `throw new Error(\`Jump host "${server.jumpHostId}" was not found.\`)`（模板字符串，未走 `t()`）。`provider.getServer` 缺失时 `throw new Error('Jump host lookup is not available.')`。跳板 `connect`/`forwardOut` 的失败以 ssh2 原始错误直接上抛，调用方无法分辨挂的是跳板还是目标机。
- 现有测试 `test/ssh/SshConnectionConfig.test.ts` 的 `'builds a routed target config through a direct jump host'` 用例甚至**断言了压扁行为**（jump 定义为 `jumpHostId: 'ignored-parent'` 且连接成功），改造后必须重写该用例。

### 1.2 `src/ssh/KeyboardInteractive.ts`

`attachKeyboardInteractive` 在无 prompt / 用户取消时分别 `onAbort(new Error('The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.'))` 和 `onAbort(new Error('Keyboard-interactive authentication was cancelled.'))`。两条都是用户可达（终端状态栏、连接测试结果、SFTP 错误 toast），均未走 `t()`，也没有稳定 `code`。

### 1.3 `src/ssh/SshConnectionTester.ts`

`testSshConnection` 把 `client.once('error', rejectOnce)` 的 ssh2 原始错误直接 reject 给 `ServerFormPanel`，后者 `formatError(error)` 展示——用户看到的是 `connect ECONNREFUSED 1.2.3.4:22`、`All configured authentication methods failed` 这类原文。仅超时消息已走 `t('Connection test timed out after {timeoutMs}ms.')`（该键已在 bundle）。

### 1.4 `src/ssh/SshConfigImport.ts`

`collectHostBlocks` 会把 `proxycommand`（小写化后）存进 `values`，但 `buildEntry` 从不读它：带 `ProxyCommand` 的主机被**当作直连导入**，之后连接必然失败且用户不知原因。多跳 `ProxyJump` 已有截断警告（`parseProxyJump`），保留。四条既有警告字符串（invalid Port / 多跳截断 / hop 解析失败）都是模板字符串拼的纯英文，未走 `t()`。

### 1.5 `src/ssh/SshSession.ts` / 调用方矩阵

`buildSshConnectionHandle` 的调用方：`SshSession.buildConnectionHandle`（传 `keyboardInteractivePrompt`）、`SftpSession.connect`（不传 options）、`RemoteCommandExecutor`（不传 options）、`extension.ts` 端口转发命令（传 prompt）、`SshConnectionTester`。`SshSession` 构造函数第 5 个可选参数是 `keyboardInteractivePrompt`，没有 secret prompt 通道。

### 1.6 i18n 机制

- `src/i18n/t.ts` 转发 `vscode.l10n.t`；测试经 `vitest.config.ts` 的 alias 走 `test-fixtures/vscode.ts`，其 `l10n.t` **原样返回英文源串并做 `{placeholder}` 插值**——因此测试断言英文完整句在 `t()` 化之后**继续成立**。
- `test/i18n/nls.test.ts` 的 `'has a zh-cn translation for every one'` 会扫描全部 `src/**/*.ts` 的 `t('…')` 字面量并要求 `l10n/bundle.l10n.zh-cn.json` 有对应键。本切片不拥有 bundle → 新增键在本切片分支上会让**这一条断言**失败，这是与切片 A 相同的已知跨切片缝（切片 A 上一轮的 `_wiring-ssh.md` 有先例），处理方式见 §8。

---

## 2. 目标行为总览

| 场景 | 现状 | 目标 |
| --- | --- | --- |
| password 认证、SecretStorage 无密码、交互式上下文 | 直接抛 'Missing password…' | 先调 `options.promptForSecret('password', server)`；拿到非空值即用；取消/空 → 抛 `code: 'missing-password'` 的已分类错误（英文源串不变） |
| password 认证、后台上下文（无 hook） | 抛 'Missing password…' | 行为不变，但错误变成已分类 + `t()` |
| 加密私钥、无存储口令、交互式 | `client.connect()` 抛 ssh2 原文 | `buildSshConnectConfig` 内用 `ssh2.utils.parseKey` 预校验发现加密 → 调 `promptForSecret('passphrase', server)` → 用新口令复验；成功注入 `passphrase`，失败抛 `code: 'bad-passphrase'` |
| 加密私钥、无口令、后台 | ssh2 原文（`Cannot parse privateKey: Encrypted…`） | 抛 `code: 'missing-passphrase'` 的已分类错误 |
| 存储口令错误 | ssh2 原文 | 预校验发现 → 有 hook 则补问一次，无 hook / 取消 → `code: 'bad-passphrase'` |
| `ECONNREFUSED`/`ETIMEDOUT`/`ENOTFOUND`/`EHOSTUNREACH`/`EAI_AGAIN`/auth failed/握手超时/agent 失败 | 原文透传 | `classifySshConnectionError` 产出稳定 `code` + 本地化可执行消息；连接测试直接受益，终端经 wiring 受益 |
| 跳板机自身有 `jumpHostId` | 静默压扁后直连跳板 | 抛 `code: 'nested-jump-host'`，禁止建立任何连接 |
| 跳板环（A→B→A、自指） | 压扁后行为随缘 | 同上——任何"跳板机自身还有跳板"都命中该 throw，环不可能形成 |
| 跳板那一腿连接失败 | 原文上抛，无法区分挂在哪台 | 用跳板机上下文分类 + `Jump host "{label}": {message}` 前缀 |
| SSH config 导入遇到 `ProxyCommand` | 当直连导入 | 跳过该主机 + 警告（`ProxyCommand none` 除外） |
| KI 无 prompt / 取消 | 纯英文普通 Error | 同句英文经 `t()`，带 `code`，且 `isMissingOrBadCredentialError` 对取消返回 `false`（取消不该触发重试弹窗） |

---

## 3. ssh2 错误消息对照表（精确子串，`ssh2@1.17.0`，实现前请在基线 `node_modules/ssh2` 复核一遍）

分类器与检测助手**只**依赖下表列出的子串/字段。所有匹配都要同时覆盖「裸消息」（`utils.parseKey` 返回的 `Error`）与「包装消息」（`client.connect()` 抛出时加 `Cannot parse privateKey: ` 前缀），用**子串包含**而非全等即可两者通吃。

### 3.1 私钥解析（`lib/protocol/keyParser.js`、`lib/client.js`）

| 精确消息 | 出处 | 归类 |
| --- | --- | --- |
| `Encrypted private OpenSSH key detected, but no passphrase given` | `keyParser.js:496`（新 OpenSSH 格式） | missing-passphrase |
| `Encrypted OpenSSH private key detected, but no passphrase given` | `keyParser.js:848`（旧 PEM 格式，`Proc-Type: 4,ENCRYPTED`） | missing-passphrase |
| `Encrypted PPK private key detected, but no passphrase given` | `keyParser.js:1047`（PuTTY PPK） | missing-passphrase |
| `OpenSSH key integrity check failed -- bad passphrase?` | `keyParser.js:632`（新格式、口令错） | bad-passphrase |
| `Malformed OpenSSH private key. Bad passphrase?` | `keyParser.js:888-889`（旧格式解密后解析失败时在 `Malformed OpenSSH private key` 后追加 `. Bad passphrase?`） | bad-passphrase |
| `PPK private key integrity check failed -- bad passphrase?` | `keyParser.js:1113` | bad-passphrase |
| `Malformed OpenSSH private key`（无追加） | `keyParser.js` 多处 | private-key-invalid |
| `Cannot parse privateKey: <inner>` | `client.js:261`，`client.connect()` **同步抛出**（在各 connect Promise 的 executor 里同步 throw → Promise 拒绝，仍会落进现有 catch） | 按 inner 再分类；inner 不匹配上面任何一条时 → private-key-invalid |
| `privateKey value does not contain a (valid) private key` | `client.js:266-268` | private-key-invalid |

**推荐匹配器**（导出常量，测试直接引用）：

- 缺口令：`/no passphrase given/`（三种格式变体的公共尾巴）。
- 口令错误：`/bad passphrase/i`（覆盖 `-- bad passphrase?` 与 `. Bad passphrase?` 两种大小写）。
- 解析失败兜底：消息包含 `Cannot parse privateKey`、或 `privateKey value does not contain`、或 `/Malformed .*private key/` 且未命中前两类。

### 3.2 认证 / 握手 / 保活（`lib/client.js`）

| 精确消息 | 附加字段 | 出处 | 归类 |
| --- | --- | --- | --- |
| `All configured authentication methods failed` | `err.level === 'client-authentication'` | `client.js:863` | auth-failed（消息全等或 level 命中，二者取或） |
| `Timed out while waiting for handshake` | `err.level === 'client-timeout'` | `client.js:1114` | handshake-timeout（**消息优先于 level**，因为 level 与保活共用） |
| `Keepalive timeout` | `err.level === 'client-timeout'` | `client.js:~721` | connection-lost |
| `Host denied (verification failed)` | — | `kex.js:1206/1233`（`hostVerifier` 返回 false） | host-key-rejected |

### 3.3 socket / DNS（Node 错误经 `client.js` 透传，`err.level = 'client-socket'` 或 `'client-dns'`）

Node 的 `ErrnoException.code`（字符串，注意 SFTP 层的 code 是数字，判断前须 `typeof code === 'string'`）：

| `code` | 归类 |
| --- | --- |
| `ECONNREFUSED` | connection-refused |
| `ETIMEDOUT` | connect-timeout |
| `EHOSTUNREACH`、`ENETUNREACH` | host-unreachable |
| `ENOTFOUND` | dns-not-found |
| `EAI_AGAIN` | dns-temporary |
| `ECONNRESET`、`EPIPE` | connection-lost |

另外：`forceIPv4/forceIPv6` 路径的 DNS 失败是 ssh2 重新 new 的 `Error('Error while looking up IPv4 address for …')`，`level === 'client-dns'`、无 `code` → 按消息前缀 `Error while looking up` 归 dns-not-found。

### 3.4 agent（`lib/agent.js` + 本仓 `resolveAgentSocket`）

| 来源 | 精确消息 | 归类 |
| --- | --- | --- |
| `agent.js:74` | `Failed to connect to agent` | agent-unavailable |
| `agent.js:88` | `Failed to retrieve identities from agent` | agent-unavailable |
| `agent.js:131` | `Failed to sign data with agent` | agent-unavailable |
| ssh2 内部 | `err.level === 'agent'` | agent-unavailable |
| 本仓 `resolveAgentSocket` | `Missing SSH agent socket. Set the SSH_AUTH_SOCK environment variable or start an SSH agent.`（改造后直接抛已分类错误，见 §4.2） | agent-unavailable |

---

## 4. 文件级改动

### 4.1 新建 `src/ssh/SshErrorClassify.ts`

依赖方向：本模块只 import `../config/schema`（类型）、`../utils/errors`（`UserVisibleError`、`formatError`）、`../i18n/t`。**禁止** import `SshConnectionConfig` / `KeyboardInteractive`（它们反过来 import 本模块，避免环）。`UserVisibleError` 子类放在本模块（`src/ssh/**` 属本切片），`src/utils/errors.ts` **不改**。

```ts
export type SshConnectionErrorCode =
  | 'missing-password'
  | 'missing-passphrase'
  | 'bad-passphrase'
  | 'private-key-invalid'
  | 'missing-private-key-path'
  | 'auth-failed'
  | 'keyboard-interactive-unavailable'
  | 'keyboard-interactive-cancelled'
  | 'agent-unavailable'
  | 'connection-refused'
  | 'connect-timeout'
  | 'handshake-timeout'
  | 'connection-lost'
  | 'dns-not-found'
  | 'dns-temporary'
  | 'host-unreachable'
  | 'host-key-rejected'
  | 'nested-jump-host'
  | 'jump-host-not-found'
  | 'jump-host-unreachable'
  | 'unknown';

/** message 必须是 display-ready（已 t()、已插值、可直接进状态栏/toast）。 */
export class ClassifiedSshConnectionError extends UserVisibleError {
  constructor(
    readonly code: SshConnectionErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ClassifiedSshConnectionError';
  }
}

/** 分类需要的最小服务器上下文；所有调用方手里都有完整 ServerConfig。 */
export type SshErrorServerContext = Pick<ServerConfig, 'host' | 'port'>;

export function classifySshConnectionError(
  error: unknown,
  server: SshErrorServerContext
): ClassifiedSshConnectionError;

/** 加密私钥但没有口令（§3.1 三变体 + Cannot parse 包装）。 */
export function isEncryptedKeyMissingPassphraseError(error: unknown): boolean;
/** 口令与私钥不匹配（§3.1 三变体 + 包装）。 */
export function isBadPassphraseError(error: unknown): boolean;
/** 私钥内容本身解析不了（非加密相关）。 */
export function isPrivateKeyParseError(error: unknown): boolean;
/**
 * TerminalPanel（wiring）用来决定"要不要弹 InputBox 重试"的总开关：
 * - true：missing-password / missing-passphrase / bad-passphrase（无论是已分类实例还是
 *   逃逸的 ssh2 原始消息命中 §3.1 缺口令/口令错子串）。
 * - false：其余一切，特别是 keyboard-interactive-cancelled（用户已经主动取消，
 *   不许再弹）与 auth-failed（是否按 authType==='password' 现场重输密码由 wiring
 *   自行叠加判断，helper 保持窄口径）。
 */
export function isMissingOrBadCredentialError(error: unknown): boolean;
```

**`classifySshConnectionError` 的判定顺序**（必须按序，先到先得）：

1. `error instanceof ClassifiedSshConnectionError` → 原样返回（幂等；跳板前缀包装等上游已定型的不再动）。
2. §3.1 凭据类：缺口令 → `missing-passphrase`；口令错 → `bad-passphrase`；其余私钥解析失败 → `private-key-invalid`。
3. auth：消息全等 `All configured authentication methods failed` 或 `level === 'client-authentication'` → `auth-failed`。
4. 主机密钥：消息含 `Host denied (verification failed)` → `host-key-rejected`。
5. 握手/保活：消息含 `Timed out while waiting for handshake` → `handshake-timeout`；含 `Keepalive timeout` → `connection-lost`。
6. errno：`typeof (error as {code?}).code === 'string'` 时按 §3.3 表映射。
7. `level === 'client-dns'` 或消息前缀 `Error while looking up` → `dns-not-found`。
8. `level === 'agent'` 或消息命中 §3.4 三条 → `agent-unavailable`。
9. 兜底：`code: 'unknown'`，`message = formatError(error)`（走既有脱敏，不新增 l10n 键）。

**各 code 的消息**（`t()` 英文源串——完整清单与建议中文见 `_wiring-b.md`，此处为规范性定义；`{host}`/`{port}` 从 `server` 参数插值）：

| code | 英文源串 |
| --- | --- |
| auth-failed | `Authentication failed. The server rejected all configured authentication methods. Check the username and the stored credentials.` |
| host-key-rejected | `Host key verification failed for {host}:{port}. Review the stored fingerprint before reconnecting.` |
| handshake-timeout | `The SSH handshake with {host}:{port} timed out. The service on that port may not be an SSH server.` |
| connection-lost | `Lost the connection to {host}:{port}. The network dropped or the server closed the connection.` |
| connection-refused | `Connection refused by {host}:{port}. Check that an SSH server is listening on that port.` |
| connect-timeout | `Connection to {host}:{port} timed out. Check the host address, network connectivity, and firewall rules.` |
| host-unreachable | `Host {host} is unreachable. Check your network connection, VPN, and routes.` |
| dns-not-found | `Could not resolve host "{host}". Check the host name and your DNS settings.` |
| dns-temporary | `Temporary DNS failure while resolving "{host}". Check your network connection and try again.` |
| agent-unavailable | `Could not reach the SSH agent. Check that the agent is running and SSH_AUTH_SOCK points at its socket.` |
| missing-passphrase | `The private key is encrypted. Enter its passphrase to connect.` |
| bad-passphrase | `The passphrase does not match the private key. Enter the correct passphrase and try again.` |
| private-key-invalid | `The private key file could not be parsed. It must be a valid OpenSSH, PEM, or PPK private key.` |
| unknown | 不新增文案，直接 `formatError(error)` |

分类时把原始错误塞进 `cause`，供日志/详情用；`message` 里**不得**拼接原始消息（脱敏与本地化都会被破坏），unknown 兜底除外。

### 4.2 `src/ssh/SshConnectionConfig.ts`

新增导出类型 + 扩展 options：

```ts
export type SecretKind = 'password' | 'passphrase';
/**
 * 交互式调用方补齐缺失凭据的回调。返回 undefined 表示用户取消；
 * 返回空串按取消处理（加密私钥不可能是空口令，空密码按缺失口径不变）。
 * 本模块从不 import vscode —— InputBox 适配器由 wiring 提供。
 */
export type SecretPrompt = (kind: SecretKind, server: ServerConfig) => Promise<string | undefined>;

export interface SshConnectOptions {
  keyboardInteractivePrompt?: KeyboardInteractivePrompt;
  promptForSecret?: SecretPrompt;
}
```

**`buildSshConnectConfig` 签名**加第 4 个可选参数（所有既有调用方不传即兼容）：

```ts
export async function buildSshConnectConfig(
  server: ServerConfig,
  passwordProvider: PasswordProvider,
  hostKeyVerifier: HostKeyVerifier,
  options: SshConnectOptions = {}
): Promise<ConnectConfig>
```

**password 分支**：

```ts
let password = await passwordProvider.getPassword(server.id);
if (!password && options.promptForSecret) {
  password = await options.promptForSecret('password', server);
}
if (!password) {
  throw new ClassifiedSshConnectionError(
    'missing-password',
    t('Missing password. Edit the server configuration and enter a password.')
  );
}
return { ...base, password };
```

英文源串与现状**逐字相同**（既有断言不动）。存储有密码时**不得**调用 prompt。

**agent 分支**：`resolveAgentSocket` 的 throw 改为 `new ClassifiedSshConnectionError('agent-unavailable', t('Missing SSH agent socket. Set the SSH_AUTH_SOCK environment variable or start an SSH agent.'))`（英文不变）。win32 回退管道逻辑不动。

**privateKey 分支**（核心改造——预校验 + 按需补口令）：

```ts
if (!server.privateKeyPath) {
  throw new ClassifiedSshConnectionError('missing-private-key-path', t('Missing private key path.'));
}
const privateKey = await readFile(server.privateKeyPath, 'utf8');
const passphrase = await resolvePassphrase(server, privateKey, passwordProvider, options);
return { ...base, privateKey, ...(passphrase ? { passphrase } : {}) };
```

私有 helper `resolvePassphrase`（不导出；行为经 `buildSshConnectConfig` 测试）：

1. `const { utils } = await getSsh2();`（`ssh2.utils.parseKey(data, passphrase?): ParsedKey | Error`，`@types/ssh2` 已带类型；返回 `Error` 而非 throw）。
2. `const stored = await provider.getPassphrase?.(server.id);` 空串归一化为 `undefined`。
3. `const first = utils.parseKey(privateKey, stored);`
   - 非 `Error` → 返回 `stored`（未加密的钥即便带着无用的 stored 口令也解析成功，行为与现状一致）。
   - `isEncryptedKeyMissingPassphraseError(first) || isBadPassphraseError(first)`：
     - 无 `options.promptForSecret` → 直接抛：stored 存在且口令错 → `bad-passphrase`；否则 → `missing-passphrase`。两者 `cause: first`。
     - 有 prompt → `const prompted = await options.promptForSecret('passphrase', server);`
       - `!prompted`（取消或空串）→ 同上分支抛（视 stored 有无定 code）。
       - 复验 `utils.parseKey(privateKey, prompted)`；成功 → 返回 `prompted`；仍是 `Error` → 抛 `bad-passphrase`（`cause` 为复验错误）。**builder 内只补问一次**；反复重试的循环属于调用方（wiring 捕获 `isMissingOrBadCredentialError` 后整体重连）。
   - 其余 `Error`（Malformed 等，非加密相关）→ 抛 `private-key-invalid`，**不弹 prompt**（换口令救不了坏文件）。
4. `readFile` 的 ENOENT/EACCES 原样上抛不包装（消息自带路径已够 actionable，分类器兜底为 unknown；不新增文案）。

注意：最终 config 仍放**原始 `privateKey` 字符串** + `passphrase`，让 ssh2 在 `connect` 里自己再 parse 一次（与现状一致，避免把 `ParsedKey` 塞进 config 造成测试与序列化行为漂移）。预校验通过后 `connect` 阶段的 parse 不可能再失败（同一份输入同一个 parser）。

**`buildSshConnectionHandle` 改造**：

1. 直连路径把 `options` 透传给 `buildSshConnectConfig(server, provider, hostKeyVerifier, options)`。
2. `provider.getServer` 缺失的 `Jump host lookup is not available.` 保持普通 `Error` 不 `t()`（纯编程错误，用户配不出来；在代码注释里写明这一决定）。`requireHostKeyVerifier` 的消息同理不动。
3. 跳板缺失改为已分类 + `t()`（英文**有变化**，同步改测试断言）：

```ts
if (!jumpHost) {
  throw new ClassifiedSshConnectionError(
    'jump-host-not-found',
    t('Jump host "{id}" was not found. Edit the server configuration and choose an existing server as the jump host.', { id: server.jumpHostId })
  );
}
```

4. **嵌套跳板拒绝**（在构造任何 `Client` 之前）：

```ts
if (jumpHost.jumpHostId) {
  throw new ClassifiedSshConnectionError(
    'nested-jump-host',
    t('Nested jump hosts are not supported. Jump host "{label}" itself uses a jump host; remove that setting or connect through a single hop.', { label: jumpHost.label })
  );
}
```

   之后 `buildSshConnectConfig(jumpHost, provider, hostKeyVerifier, options)` 直接传 `jumpHost`——`{ ...jumpHost, jumpHostId: undefined }` 的压扁写法**删除**。该 throw 同时天然封死跳板环：自指（`server.jumpHostId === server.id`）与 A→B→A 都必然让"被选中的跳板机自身带 `jumpHostId`"成立。
5. **跳板腿错误归因**：跳板 `client.connect` 的 ready/error Promise 拒绝时，catch 里包装后再抛：

```ts
const classified = classifySshConnectionError(error, jumpHost);
throw new ClassifiedSshConnectionError(
  classified.code,
  t('Jump host "{label}": {message}', { label: jumpHost.label, message: classified.message }),
  error
);
```

   注意此包装仅套在**跳板 connect**那一段（含 KI abort、`Cannot parse privateKey` 同步抛）；不要把 `buildSshConnectConfig(jumpHost, …)` 的凭据错误也包两层前缀——凭据错误消息里语义已完整，且 wiring 的重试判定只看 `code`，包一层前缀即可（实现上把 jump 的 config 构建也放进同一个 try 是可接受的，`classify` 幂等保证 code 不变，只是加了 `Jump host "…": ` 前缀，更利于归因；两种做法选一种并在测试里钉死）。**推荐**：jump 的 config 构建 + connect 放同一个 try，统一加前缀。
6. **`forwardOut` 失败**（跳板通了、跳板到目标不通）：

```ts
reject(new ClassifiedSshConnectionError(
  'jump-host-unreachable',
  t('Jump host "{label}" could not reach {host}:{port}: {message}', {
    label: jumpHost.label, host: server.host, port: server.port, message: formatError(error)
  }),
  error
));
```

7. 目标机的 `buildSshConnectConfig(server, provider, hostKeyVerifier, options)` 也透传 options（目标机缺密码同样可以现场补）。
8. 生命周期语义不变：任何失败路径 `jumpClient.end()` 后 rethrow；`dispose()` 关跳板客户端。

### 4.3 `src/ssh/KeyboardInteractive.ts`

两条 abort 错误改为已分类 + `t()`（英文源串逐字不变，全部断言它们的测试都在本切片拥有的 `test/ssh/**`）：

```ts
new ClassifiedSshConnectionError(
  'keyboard-interactive-unavailable',
  t('The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.')
)
new ClassifiedSshConnectionError(
  'keyboard-interactive-cancelled',
  t('Keyboard-interactive authentication was cancelled.')
)
```

其余逻辑（`client.end()` 拆握手、prompt 异常透传）不动。模块新增 import `t` 与 `ClassifiedSshConnectionError`（不构成环，见 §4.1 依赖方向）。

### 4.4 `src/ssh/SshConnectionTester.ts`

- 签名不变（`ServerFormPanel` 不归本切片，不能改它的调用）。表单自己收密码/口令，测试连接**不需要** `promptForSecret`。
- `rejectOnce` 内统一 `reject(classifySshConnectionError(error, server))`——`ServerFormPanel` 现有的 `formatError(error)` 会原样展示已本地化消息，无需 wiring。
- 自身超时改为 `new ClassifiedSshConnectionError('connect-timeout', t('Connection test timed out after {timeoutMs}ms.', { timeoutMs }))`——键已在 bundle，复用不新增。
- `buildSshConnectionHandle` 的拒绝（凭据、嵌套跳板、跳板腿）此时已是分类实例，`classify` 幂等，无需特判。

### 4.5 `src/ssh/SshSession.ts`

- 构造函数追加第 6 个可选参数 `private readonly promptForSecret?: SecretPrompt`（第 5 个 `keyboardInteractivePrompt` 之后；可选参数追加对 `TerminalPanel` 现有 5 参调用**不破坏编译**）。
- `buildConnectionHandle()` 里把它放进 options：`{ keyboardInteractivePrompt: this.keyboardInteractivePrompt, promptForSecret: this.promptForSecret }`。
- 其余（状态事件、重连、flow control）一律不动。`connect()` 失败仍抛原错误——分类展示在 `TerminalPanel`（wiring）做，`SshSession` 不 import 分类器。

### 4.6 `src/ssh/SshConfigImport.ts`

- 模块新增 `import { t } from '../i18n/t';`（解析器只跑在扩展宿主；测试经 vscode fixture 无碍）。
- `parseSshConfig` 的 alias 循环里，`buildEntry` 之前加 ProxyCommand 检查：

```ts
const proxyCommand = block.values.has('proxycommand') ? unquote(block.values.get('proxycommand')!) : undefined;
const skipForProxyCommand = proxyCommand !== undefined && proxyCommand !== '' && proxyCommand.toLowerCase() !== 'none';
// alias 循环内：
if (skipForProxyCommand) {
  warnings.push(t('Host "{alias}": uses ProxyCommand, which cannot be imported; the host was skipped.', { alias }));
  continue;
}
```

  语义细则：
  - **skip + warn**（合同首选），不生成 entry——不许"当直连导入再警告会失败"。
  - `ProxyCommand none` 是 OpenSSH 的显式禁用写法 → 不跳过、不警告。
  - 一个 `Host a b c` 块带 ProxyCommand → 三个 alias 全跳过，**每个 alias 一条警告**（与既有 per-alias 警告风格一致）。
  - 同一块既有 ProxyJump 又有 ProxyCommand → 跳过为先，**不再**输出 ProxyJump 相关警告（entry 都没了）。
- 既有三条警告字符串包上 `t()`（占位符化，语义与插值结果逐字不变）：
  - `t('Host "{alias}": ignored invalid Port "{port}"; using 22.', { alias, port: rawPort })`
  - `t('Host "{alias}": ProxyJump has {count} hops; only the first hop "{hop}" was imported and the rest were truncated.', { alias, count: hops.length, hop: hops[0] })`
  - `t('Host "{alias}": could not parse ProxyJump hop "{hop}"; it was skipped.', { alias, hop: hops[0] })`
- 多跳 ProxyJump 截断行为**保留原样**（合同点名不许动）。
- `SshConfigImportEntry` 结构不变；`extension.ts` 的导入命令把 `warnings.join(' ')` 进 toast 的逻辑无需改动（wiring 文件只留说明，无补丁）。

### 4.7 明确不改的文件

| 文件 | 结论 |
| --- | --- |
| `src/ssh/HostKeyStore.ts` | 不动。多算法钉多把、known_hosts 导入在 Out of scope |
| `src/ssh/VscodeKeyboardInteractivePrompt.ts` | 不动。KI prompt UI 已存在 |
| `src/ssh/ssh2Loader.ts` | 不动。`getSsh2()` 已能取到 `utils.parseKey` |
| `src/ssh/LocalPortForward.ts` | 不动 |
| `src/config/schema.ts` | 不动——分类器只需要 `ServerConfig` 类型 import，无新增字段/导出 |
| `src/utils/errors.ts` | 不动——子类放在 `SshErrorClassify.ts` |
| `src/extension.ts`、`src/webview/**`、`src/sftp/**`、`src/agent/**` | 不动，见 `_wiring-b.md` |

---

## 5. 测试

先写失败用例再改产物（总合同规程 4）。全部落在 `test/ssh/**`。

### 5.1 新建 `test/ssh/SshErrorClassify.test.ts`

纯单元，无 mock 依赖（不 import ssh2）。用 `Object.assign(new Error(msg), { code, level })` 构造样本。必须覆盖：

1. §3.3 六个 errno 逐一 → 对应 `code`，消息含 `host`（有 `{port}` 的还要含端口）。
2. `All configured authentication methods failed`（无 level）→ `auth-failed`；任意消息 + `level: 'client-authentication'` → `auth-failed`。
3. `Timed out while waiting for handshake` + `level: 'client-timeout'` → `handshake-timeout`；`Keepalive timeout` + 同 level → `connection-lost`（证明消息优先于 level）。
4. `Host denied (verification failed)` → `host-key-rejected`。
5. `Error while looking up IPv4 address for 'x'` + `level: 'client-dns'` → `dns-not-found`。
6. `Failed to connect to agent` / 任意消息 + `level: 'agent'` → `agent-unavailable`。
7. §3.1 全部六条裸消息逐一：三条 → `missing-passphrase`、三条 → `bad-passphrase`；每条再包一层 `Cannot parse privateKey: ` 前缀重测一遍。
8. `Cannot parse privateKey: Malformed OpenSSH private key`、`privateKey value does not contain a (valid) private key` → `private-key-invalid`。
9. 幂等：`classifySshConnectionError(classified, server)` 返回**同一实例**。
10. 兜底：普通 `Error('boom')` → `unknown` 且 `message === 'boom'`；非 Error 值（字符串、undefined）→ `unknown` 不抛；含 `password=secret` 的消息经兜底后被脱敏（走 `formatError`）。
11. `isMissingOrBadCredentialError`：对 `missing-password`/`missing-passphrase`/`bad-passphrase` 分类实例、以及六条 §3.1 缺口令/口令错裸消息 → `true`；对 `auth-failed`、`connection-refused`、`keyboard-interactive-cancelled`、`private-key-invalid`、普通 Error → `false`。
12. `isEncryptedKeyMissingPassphraseError` / `isBadPassphraseError` / `isPrivateKeyParseError` 各自的正反例。
13. 分类实例 `instanceof UserVisibleError` 为 true（保证 `formatError` 链路语义）。

### 5.2 `test/ssh/SshConnectionConfig.test.ts`（改造）

- **ssh2 mock 扩容**：现有 `vi.mock('ssh2', …)` 只导出 `Client`，须加 `utils: { parseKey: sshMocks.parseKey }`，`parseKey` 为可编程 `vi.fn()`（默认返回 `{}` 视为解析成功；单测按需 `mockReturnValueOnce(new Error('…'))`）。
- 保留并确认仍绿：host verifier fail-closed、keepalive/tryKeyboard、agent SSH_AUTH_SOCK 三例（消息未变）、`Missing password.` 全句、`Missing private key path.` 全句、异步 hostVerifier 用例。
- 新增 password hook 用例：
  1. 无存储密码 + prompt 返回 `'from-prompt'` → `config.password === 'from-prompt'`，prompt 以 `('password', server)` 被调用一次。
  2. 无存储密码 + prompt 返回 `undefined` → 抛出 `code === 'missing-password'`（断言 `instanceof ClassifiedSshConnectionError` 与消息全句）。
  3. prompt 返回 `''` → 同 2。
  4. 有存储密码 → prompt **不被调用**。
- 新增 passphrase 用例（均设 `authType: 'privateKey'`，`readFile` mock 返回钥文本）：
  5. `parseKey` 首次成功、无存储口令 → 无 prompt 调用、config 无 `passphrase`。
  6. 首次 `Error('Encrypted private OpenSSH key detected, but no passphrase given')`，无 prompt → 抛 `missing-passphrase`。
  7. 同上但 prompt 返回 `'pp'`、复验成功 → `config.passphrase === 'pp'`；`parseKey` 第二次调用参数为 `(keyText, 'pp')`。
  8. prompt 返回 `undefined` / `''` → 抛 `missing-passphrase`。
  9. 存储口令 `'wrong'`、首次 `Error('OpenSSH key integrity check failed -- bad passphrase?')`、无 prompt → 抛 `bad-passphrase`。
  10. 同 9 但 prompt 给新口令、复验成功 → 用新口令。
  11. prompt 给的口令复验仍失败 → 抛 `bad-passphrase`（只问一次，`parseKey` 共两次调用）。
  12. 首次 `Error('Malformed OpenSSH private key')` → 抛 `private-key-invalid` 且 prompt **不被调用**。
  13. 存储口令为 `''` → 以 `undefined` 传给 `parseKey`（断言首个调用参数）。
- 跳板用例改造：
  14. **重写** `'builds a routed target config through a direct jump host'`：jump 服务器**去掉** `jumpHostId: 'ignored-parent'`，其余断言（bastion connect、`forwardOut` 参数、`sock`、dispose）保留。
  15. 新增：`jumpHost.jumpHostId` 非空 → reject `code === 'nested-jump-host'`、消息含 jump 的 `label`，且 `Client` 构造器 0 次调用、`connect` 0 次调用。
  16. 新增：自指环 `server.jumpHostId === server.id` 且 `getServer` 返回该 server → 同样命中 `nested-jump-host`。
  17. 缺失跳板断言更新为新英文全句（`Jump host "missing-jump" was not found. Edit the server configuration…`），并断言 `code === 'jump-host-not-found'`。
  18. 跳板腿失败：`connect` mock 触发 `handlers.error(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:22'), { code: 'ECONNREFUSED', level: 'client-socket' }))` → reject 为 `ClassifiedSshConnectionError`，`code === 'connection-refused'`，消息以 `Jump host "<label>": ` 开头且含 bastion 的 host:port（**不是**目标机的）。
  19. `forwardOut` 回调传 error → reject `code === 'jump-host-unreachable'`，消息含 jump label 与目标 host:port。
  20. 既有 jump KI 两用例保留；无 prompt 的 abort 断言追加 `code === 'keyboard-interactive-unavailable'`。
  21. options 透传：直连 + 无存储密码 + handle 层传 `promptForSecret` → prompt 生效（证明 `buildSshConnectionHandle` 透传到 `buildSshConnectConfig`）。

### 5.3 `test/ssh/KeyboardInteractive.test.ts`（追加）

- 无 prompt abort 的 error 断言追加：`instanceof ClassifiedSshConnectionError`、`code === 'keyboard-interactive-unavailable'`。
- 取消 abort：`code === 'keyboard-interactive-cancelled'`，且 `isMissingOrBadCredentialError(error) === false`。
- 既有消息全句断言不变（fixture `l10n.t` 透传英文）。

### 5.4 `test/ssh/SshConnectionTester.test.ts`（追加/改造）

- client 发 `error` 为 `Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' })` → reject 的错误 `code === 'auth-failed'`、消息为本地化全句（不再是 ssh2 原文）。注意该文件 mock 了 `buildSshConnectionHandle` 但**不要** mock `SshErrorClassify`（走真分类器）。
- 既有 `'rejects connection errors…'` 用例的 `Authentication failed` 泛错误改为断言分类后行为（`code === 'unknown'`、消息保留原文）或换成上一条，二选一但要覆盖"未知错误消息不丢"。
- 超时用例：断言 `code === 'connect-timeout'` 且消息为既有 `Connection test timed out after {timeoutMs}ms.` 插值结果。
- 既有 ready/KI 用例保持绿。

### 5.5 `test/ssh/SshSession.test.ts`（追加）

- 构造时传第 6 参 `promptForSecret`，断言 `buildSshConnectionHandle` 收到 `expect.objectContaining({ promptForSecret })`（该文件已整体 mock `SshConnectionConfig`）。
- 不传第 6 参时 options 中 `promptForSecret` 为 `undefined`。

### 5.6 `test/ssh/SshConfigImport.test.ts`（追加）

1. `Host proxied` + `ProxyCommand ssh -W %h:%p bastion` → `entries` 为空，`warnings` 恰为 `['Host "proxied": uses ProxyCommand, which cannot be imported; the host was skipped.']`。
2. `ProxyCommand none` → 正常导入、无警告。
3. `Host a b` 共享块带 ProxyCommand → 两条警告、零 entry。
4. 同块 `ProxyJump x,y` + `ProxyCommand …` → 跳过 + 仅 ProxyCommand 警告，无 ProxyJump 截断警告。
5. 既有全部用例（invalid Port、多跳截断、hop 解析失败等）断言字符串不改动仍须通过（`t()` fixture 插值透传）。
6. ProxyCommand 主机被跳过时，其它主机照常导入（一个文件混合场景）。

### 5.7 明确不属于本切片的测试

`test/webview/TerminalPanel.test.ts`（错误分类展示、凭据重试按钮）、`test/sftp/**`、`test/agent/**` 一律不改。若全量跑发现它们被本切片改动破坏，说明实现越出了 §4 的行为契约，须回头修实现而不是改这些测试。

---

## 6. l10n 键

新增的 `t()` 英文源串共 **26 个**（另复用 1 个已在 bundle 的键：`Connection test timed out after {timeoutMs}ms.`，无需重复登记）。**完整 English → 建议中文对照表放在 `docs/handoffs/_wiring-b.md`**，由切片 A/集成者写入 `l10n/bundle.l10n.zh-cn.json`。本切片不得改 `l10n/**`。

占位符规范：与英文源串完全一致（`test/i18n/nls.test.ts` 校验译文占位符集合相等），全部用 `TranslationArgs` 允许的 `string | number`。

---

## 7. Wiring（本切片产出、他人执行）

详见 `docs/handoffs/_wiring-b.md`，要点：

1. **TerminalPanel**（切片 E 拥有）：`createSession` 给 `SshSession` 传第 6 参 secret prompt；`connect()`/`reconnect()` 的 catch 用 `classifySshConnectionError` 出状态文案；`isMissingOrBadCredentialError`（以及 `authType === 'password' && code === 'auth-failed'` 的现场重输）触发 InputBox → 重连；host-key 停止自动重连的既有 `isHostVerificationError` 判定保持在前（或改用 `code === 'host-key-rejected'`）。
2. **extension.ts**：端口转发命令 catch 可选升级为分类消息；SSH config 导入命令无需改动（警告已本地化、join 逻辑不变）。
3. **ServerFormPanel**（不拥有，note only）：跳板下拉建议过滤/标注自身带 `jumpHostId` 的候选。
4. l10n 键表 + `nls.test.ts` 已知缝说明。

---

## 8. 验收清单

1. `npx tsc --noEmit` 零错误（`SshSession` 第 6 参可选、`buildSshConnectConfig` 第 4 参可选，保证未 wiring 的 `TerminalPanel`/`SftpSession`/`RemoteCommandExecutor`/`ServerFormPanel` 原样编译通过）。
2. `npx vitest run`：`test/ssh/**` 全绿；全仓其余套件全绿，**唯一允许的例外**是 `test/i18n/nls.test.ts` 的 `'has a zh-cn translation for every one'`——其失败键列表必须与 `_wiring-b.md` 的 l10n 表**逐键一致**（多一键少一键都算未过验收）。若集成时切片 A 已把键合入 bundle，则该例外消失、必须全绿。
3. 行为验收（由 §5 用例承载）：
   - 缺密码 + hook → 补齐可连；取消 → `missing-password`；有存储密码不弹。
   - 加密私钥三格式（OpenSSH 新/旧、PPK）的缺口令/口令错都被识别；builder 内至多补问一次。
   - 六个 errno + auth failed + 握手超时 + agent + host denied 全部映射稳定 `code`，消息含主机上下文、可执行。
   - 嵌套跳板/自指环：任何连接建立之前抛 `nested-jump-host`；`jumpHostId: undefined` 压扁写法在代码库中不复存在（`rg 'jumpHostId: undefined' src/ssh` 为空）。
   - 跳板腿失败消息归因到跳板机（label + 跳板 host:port）。
   - ProxyCommand 主机 skip + warn；`ProxyCommand none` 不受影响；多跳 ProxyJump 警告原样保留。
   - `sftp_delete` 语义、主机密钥阻断语义、后台 fail-fast（无 prompt 不弹窗）零变化。
4. 本切片没有 import `vscode.window` 的新代码（`rg 'vscode' src/ssh` 只允许既有的 `VscodeKeyboardInteractivePrompt.ts` 与经由 `../i18n/t` 的间接依赖）。
5. 提交与推送遵循总合同（新建切片分支，禁止触碰 `main`）。

---

## 9. 边界情况（实现与测试都必须覆盖）

| 情形 | 规定行为 |
| --- | --- |
| InputBox 取消（prompt 返回 `undefined`） | builder 抛对应 `missing-*`/`bad-passphrase`；**不**在 builder 内重试；wiring 决定是否再来一轮 |
| prompt 返回空串 | 与取消同口径（ssh2 把 `''` 口令当没给；空密码按现状 falsy 检查视为缺失） |
| prompt 自身 reject/throw | 不捕获，原样上抛（prompt 是调用方代码，其错误不属于连接分类） |
| 加密私钥 + 存储口令为空串 | 归一化为 `undefined` 后走缺口令流程 |
| 未加密私钥 + 存了口令 | `parseKey` 成功，口令照传（ssh2 忽略），行为与现状一致 |
| agent 认证 + 无 `SSH_AUTH_SOCK`（linux/darwin） | `resolveAgentSocket` 抛 `agent-unavailable`（英文原句不变）；win32 仍回退 OpenSSH 管道 |
| agent 套接字存在但 agent 死了 | 连接期 `level: 'agent'` / `Failed to connect to agent` → 分类 `agent-unavailable` |
| 跳板环：自指、A→B→A、更长环 | 一律在选中跳板机时命中 `nested-jump-host`（任何环上的"下一跳"必然自带 `jumpHostId`） |
| 跳板机记录被删（悬空 id） | `jump-host-not-found`，消息给出 id 与出路 |
| 跳板通、目标从跳板不可达（`forwardOut` 失败） | `jump-host-unreachable`，消息同时含 jump label 与目标 host:port |
| KI 取消 | `keyboard-interactive-cancelled`；`isMissingOrBadCredentialError === false`（不许再弹） |
| `Cannot parse privateKey` 从 `client.connect()` 同步抛出（预校验被绕过的假设性场景，如直接手工构造 config） | 分类器按 §3.1 包装消息照样识别——这是子串匹配必须同时覆盖裸消息与包装消息的原因 |
| 后台路径（SFTP/Agent）不传 options | 零 prompt、零弹窗；错误从 ssh2 原文升级为已分类本地化消息，fail-fast 语义不变 |
| `ProxyCommand none` / 空值 | 不跳过、不警告 |
| 同块 ProxyJump + ProxyCommand | 只出 ProxyCommand 跳过警告 |
| 消息含敏感串的未知错误 | unknown 兜底走 `formatError` 脱敏 |

---

## 10. 超出范围（明确拒绝的顺手改动）

- known_hosts 导入、每主机多算法主机密钥（P2）。
- KI prompt UI 改动；`SftpManager`/`SftpSession` 注入 KI prompt（切片 C；所需导出已齐备，见 §0 非目标）。
- 跳板多跳递归实现；服务器表单的嵌套跳板校验 UI（wiring note）。
- 弹出凭据的持久化（保存回 SecretStorage）与"保存密码"勾选（wiring/切片 E）。
- `TerminalPanel` 的认证失败按钮（编辑服务器/重试/重输密码）UX——本切片只交付 `code` 与助手。
- `keepAliveInterval` 接线、面板序列化、树单击复用（切片 E）。
- SFTP 死会话重建、2FA（切片 C）；命令超时杀进程（切片 D）。
- 把 `redaction.ts` 的脱敏规则扩到 passphrase/URL（P2，见建议文档）。
