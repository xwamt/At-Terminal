# 切片 D wiring（由集成者粘贴，切片 D 自身不改这些文件）

来源细则：`docs/handoffs/plans/slice-d-agent-mcp.md`。两个补丁互相独立；均为纯增量，未合入时切片 D 分支照常编译、测试全绿（走降级路径），合入后能力点亮。

---

## 1. `src/extension.ts` — 主机密钥模态框 120s 上限（归属：切片 E 的文件）

背景：Agent 的后台 SFTP / 命令连接会经由 `buildSshConnectionHandle → hostKeyVerifier.verify` 弹出模态框。人不在时模态框永远悬着，切片 D 已给 Agent 连接加 60s 超时并把错误引导到 IDE；本补丁给弹窗本身加 120s 封顶，避免 verify 的 Promise 无限期占用。超时按"未信任"处理（返回 false）——**主机密钥默认阻断语义不变**，任何信任仍必须是用户显式点击。VS Code 的模态框无法编程关闭：超时后弹窗仍在屏幕上，用户稍后点击 "Trust and Connect" 依然会把指纹写入 `hostKeyStore`，Agent 下一次重试即可成功——这是设计行为，请保留注释说明。

在 `activate` 顶部常量区加：

```ts
/**
 * A host key modal nobody answers must not hold connect promises forever. On timeout the
 * connection is refused (fail closed); the modal itself stays on screen, and a later click
 * on Trust still records the fingerprint so the next attempt succeeds.
 */
const HOST_KEY_PROMPT_TIMEOUT_MS = 120_000;

function raceWithTimeout<T>(promise: Thenable<T>, timeoutMs: number): Promise<T | undefined> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), timeoutMs);
      (timer as { unref?(): void }).unref?.();
    })
  ]);
}
```

`hostKeyVerifier.verify` 中，把：

```ts
const answer = await vscode.window.showWarningMessage(
  t('Trust SSH host {host}:{port}? Fingerprint: {fingerprint}', { host, port, fingerprint }),
  { modal: true },
  trustAction
);
```

替换为：

```ts
const answer = await raceWithTimeout(
  vscode.window.showWarningMessage(
    t('Trust SSH host {host}:{port}? Fingerprint: {fingerprint}', { host, port, fingerprint }),
    { modal: true },
    trustAction
  ),
  HOST_KEY_PROMPT_TIMEOUT_MS
);
```

（`answer === undefined` 时既有代码路径已返回 `false`，无需其他改动。）

`promptChangedHostKey`（密钥**变更**弹窗）内的 `showWarningMessage` 同法用 `raceWithTimeout(…, HOST_KEY_PROMPT_TIMEOUT_MS)` 包一层；超时返回 `false` 保持阻断。变更弹窗的按钮与默认阻断语义一律不动（IMPLEMENTATION-PLAN 规程第 6 条）。

与切片 D 的配合：Agent 侧 SFTP 连接超时是 60s，短于弹窗的 120s。Agent 先失败并提示 "A host key or authentication prompt may be waiting in the IDE; ask the user to check the IDE window, then retry."，用户处理完弹窗后重试成功。不要把两个数值调成一样——弹窗要给人留比 Agent 更长的时间。

建议回归（放在集成者可改的 `test/extension/**`，或手测）：verify 挂起 120s 后 resolve false；用户在超时后点击 Trust 仍写入 hostKeyStore。

---

## 2. `src/sftp/SftpTypes.ts` + `src/sftp/SftpSession.ts` — 富 stat / lstat / readlink（归属：切片 C 的文件，纯增量）

切片 D 的 `AgentSftpSession` 接口把 `lstat`/`readlink` 声明为**可选**、把 stat 的富字段声明为**可选**，因此本补丁未合入时一切照常；合入后 `sftp_stat_path` 的 `mode`/`uid`/`gid`/`linkTarget` 与更快的符号链接判定自动生效。与切片 C 在同文件的改动（KI prompt、死会话重建）不冲突：以下全部是新增成员/新增字段，合并时按位置粘贴即可。

### `src/sftp/SftpTypes.ts`

`SftpFileStat` 增加可选字段（保持既有两个必填字段不动）：

```ts
export interface SftpFileStat {
  size: number;
  modifiedAt: number;
  /**
   * 'file' | 'directory' | 'symlink'. stat() follows links so it never reports
   * 'symlink'; only lstat() does.
   */
  type?: SftpEntryType;
  /** Permission bits as an octal string, e.g. '0644' (mode & 0o7777). */
  mode?: string;
  uid?: number;
  gid?: number;
}
```

（`SftpEntryType` 已在同文件导出，无新增 import。）

### `src/sftp/SftpSession.ts`

1. `stat` 改为经过统一映射（`statRaw` 不动）：

```ts
async stat(path: string): Promise<SftpFileStat> {
  return toFileStat(await this.statRaw(path));
}
```

2. 类内新增两个方法（放在 `stat` 之后）：

```ts
/** Like stat but does not follow symlinks, so links report themselves. */
async lstat(path: string): Promise<SftpFileStat> {
  const sftp = this.requireSftp();
  const attrs = await new Promise<Stats>((resolve, reject) => {
    sftp.lstat(path, (error, stat) => (error ? reject(error) : resolve(stat)));
  });
  return toFileStat(attrs);
}

/** Raw symlink target as stored on the server; may be a relative path. */
async readlink(path: string): Promise<string> {
  const sftp = this.requireSftp();
  return await new Promise<string>((resolve, reject) => {
    sftp.readlink(path, (error, target) => (error ? reject(error) : resolve(target)));
  });
}
```

3. 文件底部（其他模块级函数旁）新增映射函数：

```ts
function toFileStat(attrs: Stats): SftpFileStat {
  return {
    size: attrs.size,
    modifiedAt: attrs.mtime,
    type: attrs.isDirectory() ? 'directory' : attrs.isSymbolicLink() ? 'symlink' : 'file',
    mode: `0${(attrs.mode & 0o7777).toString(8)}`,
    uid: attrs.uid,
    gid: attrs.gid
  };
}
```

（`Stats` 已在文件顶部的 `ssh2` type import 里。）

合入后建议在 `test/sftp/SftpSession.test.ts`（切片 C 所有）补：`toFileStat` 对 0o100644 报 `mode:'0644'`、`type:'file'`；lstat 对符号链接报 `type:'symlink'`；readlink 透传目标字符串。切片 D 侧无需新测试——`test/agent/SftpAgentService.test.ts` 的富 stat 用例用 fake 会话已覆盖消费端。

---

## 3. l10n

本切片无新增用户可见字符串（所有新错误文案是 Agent 工具返回值，按约定保持英文），host-key 超时也不新增文案。`l10n/bundle.l10n.zh-cn.json` 无需追加任何键。
