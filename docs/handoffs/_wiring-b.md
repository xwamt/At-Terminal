# Wiring notes — 切片 B（connectivity）

本文件是切片 B（细则：`docs/handoffs/plans/slice-b-connectivity.md`）落在**所有权之外**的补丁片段与 l10n 键表。切片 B 自身只改 `src/ssh/**` 与 `test/ssh/**`；下面的代码由拥有对应文件的切片（主要是 E：`src/extension.ts`、`src/webview/TerminalPanel.ts`）或集成者粘贴。片段基于基线 `27deea6` 的符号，行号可能漂移。

切片 B 提供的新导出（粘贴方按此 import）：

- `src/ssh/SshConnectionConfig.ts`：`SecretKind`、`SecretPrompt`（`SshConnectOptions` 新增 `promptForSecret?: SecretPrompt`）
- `src/ssh/SshErrorClassify.ts`：`classifySshConnectionError(error, server)`、`isMissingOrBadCredentialError(error)`、`ClassifiedSshConnectionError`（含 `.code`）
- `src/ssh/SshSession.ts`：构造函数第 6 个可选参数 `promptForSecret?: SecretPrompt`

---

## 1. TerminalPanel — secret prompt 注入（切片 E 拥有 `src/webview/TerminalPanel.ts`）

切片 B 不调用 `vscode.window`，InputBox 适配器放在 TerminalPanel（或 E 自选的模块）：

```ts
import type { SecretPrompt } from '../ssh/SshConnectionConfig';

function createVscodeSecretPrompt(): SecretPrompt {
  return async (kind, server) => {
    const value = await vscode.window.showInputBox({
      title:
        kind === 'password'
          ? t('Password for {username}@{host}', { username: server.username, host: server.host })
          : t('Passphrase for the private key of {label}', { label: server.label }),
      prompt:
        kind === 'password'
          ? t('The stored password is missing. Enter it to connect.')
          : t('The private key is encrypted. Enter its passphrase to connect.'),
      password: true,
      ignoreFocusOut: true
    });
    // 空串按取消处理，与 buildSshConnectConfig 的口径一致。
    return value || undefined;
  };
}
```

`createSession` 里作为 `SshSession` 的第 6 个参数传入（第 5 个是既有的 KI prompt）：

```ts
const session = new SshSession(
  this.server,
  this.configManager,
  { /* events 不变 */ },
  this.hostKeyVerifier,
  createVscodeKeyboardInteractivePrompt(),
  createVscodeSecretPrompt()
);
```

注意：后台路径（`SftpAgentService`、`RemoteCommandExecutor`、切片 C 的后台 SFTP 会话）**不得**传 `promptForSecret`——不传即维持 fail-fast，无弹窗。

是否把弹出的密码/口令存回 SecretStorage（`configManager.saveServer(server, password)` / `saveServer(server, undefined, passphrase)`）由 E 决定；建议连接成功后再问一次「保存？」，失败的凭据不要落盘。

## 2. TerminalPanel — 连接失败分类展示与凭据重试

`connect()` 与 `reconnect()` 的 catch 目前是 `this.postStatus({ state: 'disconnected', text: formatError(error) })`。改造后的形态如下（以 `reconnect(options)` 为例；`connect()` 没有 `options` 参数，等价于 `options.auto === false` 的分支）：

```ts
import { classifySshConnectionError, isMissingOrBadCredentialError } from '../ssh/SshErrorClassify';

} catch (error) {
  if (generation !== this.connectionGeneration) {
    return;
  }
  this.connected = false;
  this.terminalContext?.markDisconnected(this.terminalId);
  this.clearIdleDisconnect();

  const classified = classifySshConnectionError(error, this.server);
  this.postStatus({ state: 'disconnected', text: classified.message });

  // 既有的 host-key 判定保持在最前（reconnect() 路径）：
  // isHostVerificationError(error) 可以整体替换为 classified.code === 'host-key-rejected'，
  // 两者对 ssh2 的 'Host denied (verification failed)' 等价；换掉后可删除英文正则匹配。
  if (classified.code === 'host-key-rejected') {
    this.postTerminalNotice(t('Reconnect stopped: host key verification failed.'));
    return;
  }

  // 凭据类：弹 InputBox 重来一轮（prompt 在 buildSshConnectConfig 内部被调用，
  // 这里只需要触发一次 reconnect；用户在 InputBox 上取消则本轮以 missing-* 结束，不再循环）。
  const retryableCredential =
    isMissingOrBadCredentialError(error) ||
    (classified.code === 'auth-failed' && this.server.authType === 'password');
  if (retryableCredential && !options?.auto) {
    const enter = t('Enter credentials');
    const edit = t('Edit server');
    void vscode.window
      .showErrorMessage(classified.message, enter, edit)
      .then((choice) => {
        if (choice === enter) {
          void this.reconnect();
        } else if (choice === edit) {
          void vscode.commands.executeCommand('sshManager.editServer', /* 该服务器的 tree item 或 id，按 E 的命令签名 */);
        }
      });
    return;
  }

  if (options?.auto) {
    this.scheduleAutoReconnect();
  }
}
```

要点：

- `auth-failed && authType === 'password'` 的「当场重输密码」需要让下一轮 `buildSshConnectConfig` 拿不到旧密码——最简单的做法是 E 在用户点了 Enter credentials 后先 `await configManager.deletePassword?.(server.id)` 或给 `SecretPrompt` 加一个「强制询问」旗标；两种都超出切片 B 的 hook 契约，属 E 的实现自由。若不想做，`retryableCredential` 去掉 auth-failed 分支即可，`isMissingOrBadCredentialError` 单独使用也成立。
- `keyboard-interactive-cancelled` 会被 `isMissingOrBadCredentialError` 排除：用户主动取消不重试、不弹窗。
- 自动重连（`options.auto`）路径不弹 InputBox，避免夜里循环弹窗。
- `createSession` 的 `error` 事件回调（`error: (error) => this.postStatus(...)`）同样可换成 `classifySshConnectionError(error, this.server).message`。

## 3. extension.ts — 可选升级点（集成者酌情）

1. **端口转发命令** `sshManager.forwardLocalPort` 的 catch：`formatError(error)` → `classifySshConnectionError(error, server).message`。非必需（tester 与终端是主要出口），做了更一致。
2. **SSH config 导入命令** `sshManager.importSshConfig`：**无需改动**。`parseSshConfig` 的 warnings（含新的 ProxyCommand 跳过警告）已在解析器内本地化，既有 `warnings.join(' ')` 进 toast 的逻辑照旧。
3. **连接测试**：`ServerFormPanel` 无需改动——`testSshConnection` 现在 reject 已分类、已本地化的错误，`formatError` 原样透传。

## 4. ServerFormPanel — 嵌套跳板预警（note only，切片 B/E 都不强制）

`buildFormHtml` 的 `jumpHostOptions` 目前只过滤自身 id。建议追加过滤或标注自身带 `jumpHostId` 的候选，避免用户配出一定会被 `nested-jump-host` 拒绝的组合：

```ts
const jumpHostOptions = servers.filter(
  (candidate) => candidate.id !== server?.id && !candidate.jumpHostId
);
```

或保留候选但在 option 文案追加 `t('(has its own jump host — not supported)')`。不做也不阻塞：运行时错误消息已可执行。

## 5. l10n 键（切片 A / 集成者写入 `l10n/bundle.l10n.zh-cn.json`）

### 5.1 切片 B 源码新增的 26 键

| English source | 建议中文 |
| --- | --- |
| `Missing password. Edit the server configuration and enter a password.` | `缺少密码。请编辑服务器配置并输入密码。` |
| `Missing private key path.` | `缺少私钥路径。` |
| `Missing SSH agent socket. Set the SSH_AUTH_SOCK environment variable or start an SSH agent.` | `未找到 SSH agent 套接字。请设置 SSH_AUTH_SOCK 环境变量或启动 SSH agent。` |
| `Nested jump hosts are not supported. Jump host "{label}" itself uses a jump host; remove that setting or connect through a single hop.` | `不支持多级跳板。跳板机 "{label}" 自身还配置了跳板；请移除该配置，或改为单跳连接。` |
| `Jump host "{id}" was not found. Edit the server configuration and choose an existing server as the jump host.` | `未找到跳板机 "{id}"。请编辑服务器配置，选择一个存在的服务器作为跳板。` |
| `Jump host "{label}": {message}` | `跳板机 "{label}"：{message}` |
| `Jump host "{label}" could not reach {host}:{port}: {message}` | `跳板机 "{label}" 无法连接 {host}:{port}：{message}` |
| `The private key is encrypted. Enter its passphrase to connect.` | `私钥已加密。请输入私钥口令后再连接。` |
| `The passphrase does not match the private key. Enter the correct passphrase and try again.` | `口令与私钥不匹配。请输入正确的私钥口令后重试。` |
| `The private key file could not be parsed. It must be a valid OpenSSH, PEM, or PPK private key.` | `无法解析私钥文件。它必须是有效的 OpenSSH、PEM 或 PPK 私钥。` |
| `Authentication failed. The server rejected all configured authentication methods. Check the username and the stored credentials.` | `认证失败。服务器拒绝了所有已配置的认证方式。请检查用户名与已保存的凭据。` |
| `Connection refused by {host}:{port}. Check that an SSH server is listening on that port.` | `{host}:{port} 拒绝了连接。请确认该端口上有 SSH 服务在监听。` |
| `Connection to {host}:{port} timed out. Check the host address, network connectivity, and firewall rules.` | `连接 {host}:{port} 超时。请检查主机地址、网络连通性和防火墙规则。` |
| `The SSH handshake with {host}:{port} timed out. The service on that port may not be an SSH server.` | `与 {host}:{port} 的 SSH 握手超时。该端口上的服务可能不是 SSH 服务器。` |
| `Could not resolve host "{host}". Check the host name and your DNS settings.` | `无法解析主机名 "{host}"。请检查主机名和 DNS 设置。` |
| `Temporary DNS failure while resolving "{host}". Check your network connection and try again.` | `解析 "{host}" 时出现暂时性 DNS 故障。请检查网络连接后重试。` |
| `Host {host} is unreachable. Check your network connection, VPN, and routes.` | `无法到达主机 {host}。请检查网络连接、VPN 和路由。` |
| `Lost the connection to {host}:{port}. The network dropped or the server closed the connection.` | `与 {host}:{port} 的连接已中断。网络断开或服务器关闭了连接。` |
| `Could not reach the SSH agent. Check that the agent is running and SSH_AUTH_SOCK points at its socket.` | `无法访问 SSH agent。请确认 agent 正在运行且 SSH_AUTH_SOCK 指向其套接字。` |
| `Host key verification failed for {host}:{port}. Review the stored fingerprint before reconnecting.` | `{host}:{port} 的主机密钥校验未通过。请先处理已存储的指纹，再重新连接。` |
| `The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.` | `服务器要求键盘交互认证，但当前上下文没有可用的交互提示。` |
| `Keyboard-interactive authentication was cancelled.` | `键盘交互认证已取消。` |
| `Host "{alias}": ignored invalid Port "{port}"; using 22.` | `主机 "{alias}"：忽略无效的 Port "{port}"，使用 22。` |
| `Host "{alias}": ProxyJump has {count} hops; only the first hop "{hop}" was imported and the rest were truncated.` | `主机 "{alias}"：ProxyJump 有 {count} 跳；只导入了第一跳 "{hop}"，其余已截断。` |
| `Host "{alias}": could not parse ProxyJump hop "{hop}"; it was skipped.` | `主机 "{alias}"：无法解析 ProxyJump 跳 "{hop}"，已跳过。` |
| `Host "{alias}": uses ProxyCommand, which cannot be imported; the host was skipped.` | `主机 "{alias}"：使用了 ProxyCommand，无法导入；已跳过该主机。` |

复用键（已在 bundle，勿重复添加）：`Connection test timed out after {timeoutMs}ms.`

### 5.2 本文件 wiring 片段引入的键（随 E 落地时一并添加）

| English source | 建议中文 |
| --- | --- |
| `Password for {username}@{host}` | `{username}@{host} 的密码` |
| `Passphrase for the private key of {label}` | `{label} 私钥的口令` |
| `The stored password is missing. Enter it to connect.` | `未保存密码。请输入密码以连接。` |
| `Enter credentials` | `输入凭据` |
| `Edit server` | `编辑服务器` |
| `(has its own jump host — not supported)` | `（自身配置了跳板——不支持）` |

（`Reconnect stopped: host key verification failed.` 已在 bundle。）

## 6. 已知跨切片缝

- 在切片 B 分支上，`test/i18n/nls.test.ts` 的 `'has a zh-cn translation for every one'` 会且只会因 §5.1 的 26 个键缺 bundle 而失败（与上一轮切片 A 的先例相同）。集成者把 §5.1 写入 `l10n/bundle.l10n.zh-cn.json` 后必须全绿。其余全部套件在切片 B 分支上应保持绿色。
- `TerminalPanel.isHostVerificationError` 与分类器的 `host-key-rejected` 语义重复；E 接线时二选一，删除另一个，避免两套英文匹配漂移。
