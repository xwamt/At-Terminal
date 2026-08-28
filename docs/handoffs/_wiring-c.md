# Wiring — slice C (sftp-runtime)

以下是切片 C 无法自己落地的补丁:目标文件属于其他切片(`src/extension.ts` 属 E,
`src/agent/**` 属 D,`l10n/**` 属 A)。集成者在合入 `cursor/slice-c-sftp-runtime-11f8` 时
按序粘贴。除 W-2、W-6 标注"可选"外均为必须——不合 W-1/W-3,切片 C 的 2FA 与预览降噪
就只完成了一半(代码就绪但未被调用)。

切片 C 已交付的 API(供对照,均在 `src/sftp/**` 内):

- `SftpSessionOptions.keyboardInteractive?: KeyboardInteractivePrompt`(可选;不传 = 现状 fail-fast)。
- `SftpSession.isConnected()` 在 ssh2 `close`/`end`/`error` 后返回 `false`;
  `SftpManager.ensureSession` 自动销毁并重建死会话(对 `extension.ts` 透明,无需接线)。
- `SftpManager.downloadFile(remotePath, localPath, serverId?, options?: TransferRunOptions)` ——
  新第 4 参,`{ notification: 'quiet' }` 时无进度通知与成功 toast(失败仍提示)。
- `src/sftp/uploadWithConflict.ts`:`uploadLocalPathsWithConflictPrompt(options)`、
  `createVscodeUploadConflictResolver()`、`localUploadFileName`(自
  `SftpDragAndDropController` 移入并原地 re-export,**既有 import 不需要改**)。
- `SftpDragAndDropController` 第二参:`{ refresh?, resolveConflict? }`(可选,旧构造仍编译)。
- `openRemotePreviewFile` 现以 `{ preview: true }` 打开,并用状态栏(Window)进度包住下载。

---

## W-1(必须)`extension.ts` — 用户 SFTP 会话注入 keyboard-interactive

`createVscodeKeyboardInteractivePrompt` 已在 `extension.ts` 中 import(本地端口转发命令在用),
无需新增 import。

替换(现行 80–85 行):

```ts
const sftpManager = new SftpManager({
  // The SFTP view is driven by the user, so a denied write may retry under sudo.
  createSession: (terminal) =>
    new SftpSession(terminal.server, configManager, hostKeyVerifier, { allowSudoFallback: true }),
  reporter: new VscodeTransferReporter()
});
```

为:

```ts
const sftpManager = new SftpManager({
  // The SFTP view is driven by the user, so a denied write may retry under sudo and
  // keyboard-interactive (2FA) rounds may prompt through the InputBox.
  createSession: (terminal) =>
    new SftpSession(terminal.server, configManager, hostKeyVerifier, {
      allowSudoFallback: true,
      keyboardInteractive: createVscodeKeyboardInteractivePrompt()
    }),
  reporter: new VscodeTransferReporter()
});
```

**agent 工厂保持原样,不要注入**(现行 181–190 行内的这几行原封不动):

```ts
createSession: (target) =>
  new SftpSession(target.server, configManager, hostKeyVerifier, { allowSudoFallback: false }),
```

后台会话没有 UI 可看,`keyboardInteractive` 缺省 `undefined` = 维持 fail-fast,这是有意行为。

## W-2(可选,行为等价)`extension.ts` — Upload 命令切到共用帮助函数

冲突循环现在有单一实现(`uploadLocalPathsWithConflictPrompt`),拖拽已在用。Upload 命令切过去
可消除双份逻辑。新增 import:

```ts
import {
  createVscodeUploadConflictResolver,
  uploadLocalPathsWithConflictPrompt
} from './sftp/uploadWithConflict';
```

(切换后 `extension.ts` 若不再直接使用 `isSftpConflictError` 与 `stat`(`node:fs/promises`),
删掉对应 import。`localUploadFileName` 的既有 import 路径无需改。)

替换 `sshManager.sftp.upload` 命令体(现行 625–672 行)为:

```ts
vscode.commands.registerCommand('sshManager.sftp.upload', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
  await runSftpCommand(async () => {
    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true
    });
    if (!files?.length) {
      return;
    }
    const state = sftpManager.getState();
    const targetDirectory = getTargetDirectory(item, state.kind === 'active' ? state.rootPath : '.');
    await uploadLocalPathsWithConflictPrompt({
      target: sftpManager,
      localPaths: files.map((file) => file.fsPath),
      remoteDir: targetDirectory,
      resolveConflict: createVscodeUploadConflictResolver()
    });
    sftpTreeProvider.refresh(item instanceof SftpDirectoryTreeItem ? item : undefined);
  });
}),
```

语义与现行代码逐点一致:目录走 `uploadDirectory`、`overwriteAll` 跨条目、Esc/Skip 跳过、
非冲突错误抛给 `runSftpCommand` 统一 toast。按钮字符串(`Overwrite`/`Overwrite All`/`Skip`)
在 zh 包中已存在。

## W-3(必须)`extension.ts` — 预览下载走 quiet 通知

`sshManager.sftp.openPreview` 命令(现行 779–788 行)里,替换:

```ts
downloadFile: (remotePath, localPath) => sftpManager.downloadFile(remotePath, localPath),
```

为:

```ts
// Preview clicks fire constantly; the Window-location spinner inside openRemotePreviewFile
// is the only feedback needed. Failures still notify.
downloadFile: (remotePath, localPath) =>
  sftpManager.downloadFile(remotePath, localPath, undefined, { notification: 'quiet' }),
```

过渡状态说明:W-3 合入前,预览是"Notification 完整进度 + Window 进度并存、仍有成功 toast",
`preview: true` 已生效——不是 bug,合入本条即消失。显式 Download 命令(另存)不改,保持完整通知。

## W-4(必须)`extension.ts` — 拖拽后刷新 SFTP 树

`createTreeView('sshManager.sftpFiles', ...)`(现行 290–294 行)里,替换:

```ts
dragAndDropController: new SftpDragAndDropController(sftpManager),
```

为:

```ts
dragAndDropController: new SftpDragAndDropController(sftpManager, {
  refresh: () => sftpTreeProvider.refresh()
}),
```

不传 `resolveConflict` —— 缺省即 VS Code 模态对话框。

## W-5(告知 D / 集成者;切片 C 不改 agent 文件)

`src/agent/SftpAgentService.ts` 的 `terminalSessions` 与本切片修掉的 `SftpManager` 死会话是同构
问题:`ensureTerminalSession` 缓存 promise 直到终端关闭,从不检查存活。`SftpSession.isConnected()`
现在语义正确,D 或集成者可以在 `ensureTerminalSession` 命中缓存处加同样的检查,形如:

```ts
private async ensureTerminalSession(context: TerminalContext): Promise<AgentSftpSession> {
  const existing = this.terminalSessions.get(context.terminalId);
  if (existing) {
    const session = await existing.promise;
    if (session.isConnected()) {
      return session;
    }
    this.terminalSessions.delete(context.terminalId);
    session.dispose();
  }
  // ...其余创建路径不变
}
```

需要 D 把 `isConnected(): boolean` 加进 agent 侧的会话接口(`AgentSftpSession` 或等价类型)。
`backgroundSessions` 有 idle TTL 兜底,优先级低,同样的检查同样适用。**本条未合入前,agent 侧
行为与基线一致,不构成回归。**

## W-6(可选项)`extension.ts` + l10n — symlink 删除确认不按目标内容计数

`sshManager.sftp.delete` 命令(现行 698–717 行)中,替换 message 计算:

```ts
const message =
  item.entry.type === 'directory' || item.entry.targetType === 'directory'
    ? t('Delete remote directory "{path}"? {count} entries will be permanently deleted.', {
        path: item.entry.path,
        count: await sftpManager.countDeletableEntries(item.entry.path)
      })
    : t('Delete remote {type} "{path}"?', { type: item.entry.type, path: item.entry.path });
```

为:

```ts
const isRealDirectory = item.entry.type === 'directory';
const message = isRealDirectory
  ? t('Delete remote directory "{path}"? {count} entries will be permanently deleted.', {
      path: item.entry.path,
      count: await sftpManager.countDeletableEntries(item.entry.path)
    })
  : item.entry.type === 'symlink' && item.entry.targetType === 'directory'
    ? t('Delete remote symlink "{path}"? Only the link is deleted; the target is kept.', {
        path: item.entry.path
      })
    : t('Delete remote {type} "{path}"?', { type: item.entry.type, path: item.entry.path });
```

理由:`SftpManager.deleteEntry` 对 `type !== 'directory'` 走 `deleteFile`(unlink),指向目录的
symlink 实际只删链接本身;现行确认框却用 `countDeletableEntries` 追进目标目录数出"N 个条目将被
永久删除",既吓人又不准确(且多一次递归遍历)。删除行为本身不变,只改文案与计数。

配套 l10n(`l10n/bundle.l10n.zh-cn.json`,A/集成者落):

```json
{
  "Delete remote symlink \"{path}\"? Only the link is deleted; the target is kept.":
    "删除远程符号链接“{path}”？仅删除链接本身，其指向的目标会保留。"
}
```

不合本条时**无新 l10n key**——切片 C 自有代码全部复用既有条目,`test/i18n/nls.test.ts`
在 C 分支上保持绿。

## W-7(知会)共享测试夹具的一处纯新增

切片 C 在 `test-fixtures/vscode.ts` 的 `Uri` 类上新增了静态方法 `parse(value: string): Uri`
(拖拽测试需要解析 `file://` URI)。该文件不在任何切片所有权清单内;此改动为**纯新增**,
不触碰既有成员,不可能影响其他切片的测试。合并冲突时保留双方新增即可。
