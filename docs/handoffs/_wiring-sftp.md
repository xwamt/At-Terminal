# Wiring — slice B (sftp)

Everything below is code slice B could not apply itself because the files belong to other
slices (`src/extension.ts`, `package.json`, `l10n/**`). The integrator applies these when
merging into `cursor/implement-optimizations-11f8`.

Branch: `cursor/slice-b-sftp-905c`. Verified: `npx vitest run test/sftp test/tree` (143
passing) and `npx tsc --noEmit`.

## New API summary (already implemented in this slice)

- `SftpSession` / `SftpManager`:
  - `uploadDirectory(localDir, remoteDir, [serverId,] options?)`, `downloadDirectory(remoteDir, localDir, [serverId])` — recursive, concurrency 4, one aggregated progress notification.
  - `deleteDirectory(path)` is now recursive; `countDeletableEntries(path)` returns how many entries a recursive delete removes (the directory itself included — an empty directory counts 1).
  - `uploadFile(..., { overwrite?: boolean })` — without `overwrite: true` an existing remote path raises `SftpConflictError` (from `src/sftp/SftpErrors.ts`, guard: `isSftpConflictError`). `TransferService` deliberately does **not** show a "failed" toast for conflicts; the UI prompt below is the resolution.
  - `readFile(path, maxBytes, offset = 0)` — negative offset reads from the end (tail). Reads and `writeFile` now pipeline 8×32KiB requests.
  - `SftpManager.listDirectory` caches per `(terminalId, path)` for 20s (`LISTING_CACHE_TTL_MS`), invalidated on upload/rename/mkdir/delete/create.
  - `SftpManager.getActiveViewDescriptor()` + `shouldRefreshOnContextChange(prev, next)` (exported from `src/tree/SftpTreeProvider.ts`) — see snippet 1.
- `SftpEntry.targetType` (`'file' | 'directory'`) is set for symlinks; symlink-to-directory renders as an expandable directory item with contextValue `sftpDirectory`.
- Tiny ops (mkdir/rename/delete/createFile) no longer show a success toast or progress notification (failures still notify). Slice E's plan to gate these in extension command wrappers is unnecessary.
- `SftpFileTreeItem` now sets `command: sshManager.sftp.openPreview` with `arguments: [this]`, so single click = preview. **No `package.json` change is needed**: the command is already registered and no new commands/menus are added by this slice.

## 1. `extension.ts` — skip redundant SFTP tree refresh on context change

Add to the imports:

```ts
import { SftpTreeProvider, shouldRefreshOnContextChange } from './tree/SftpTreeProvider';
```

Replace:

```ts
terminalContext.onDidChangeActiveContext((activeContext) => {
  sftpManager.setTerminalContext(activeContext);
  sftpTreeProvider.refresh();
});
```

with:

```ts
terminalContext.onDidChangeActiveContext((activeContext) => {
  const previousView = sftpManager.getActiveViewDescriptor();
  sftpManager.setTerminalContext(activeContext);
  if (shouldRefreshOnContextChange(previousView, sftpManager.getActiveViewDescriptor())) {
    sftpTreeProvider.refresh();
  }
});
```

Switching back to the same terminal with the same root path and connection state no longer
re-lists every visible directory. (Listings that do run are additionally served from the
20s cache.)

## 2. `extension.ts` — upload conflict mapping (overwrite / skip / overwrite all)

Add to the imports:

```ts
import { isSftpConflictError } from './sftp/SftpErrors';
```

Replace the body of the `sshManager.sftp.upload` command:

```ts
vscode.commands.registerCommand('sshManager.sftp.upload', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
  await runSftpCommand(async () => {
    const files = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
    if (!files?.length) {
      return;
    }
    const state = sftpManager.getState();
    const targetDirectory = getTargetDirectory(item, state.kind === 'active' ? state.rootPath : '.');
    let overwriteAll = false;
    for (const file of files) {
      const remotePath = joinRemotePath(targetDirectory, localUploadFileName(file.fsPath));
      try {
        await sftpManager.uploadFile(file.fsPath, remotePath, undefined, { overwrite: overwriteAll });
      } catch (error) {
        if (!isSftpConflictError(error)) {
          throw error;
        }
        const overwrite = t('Overwrite');
        const overwriteEverything = t('Overwrite All');
        const skip = t('Skip');
        // error.message is already localized ("Remote path already exists: {path}").
        const choice = await vscode.window.showWarningMessage(
          error.message,
          { modal: true },
          overwrite,
          overwriteEverything,
          skip
        );
        if (choice === overwrite || choice === overwriteEverything) {
          overwriteAll = choice === overwriteEverything;
          await sftpManager.uploadFile(file.fsPath, remotePath, undefined, { overwrite: true });
        }
      }
    }
    sftpTreeProvider.refresh(item instanceof SftpDirectoryTreeItem ? item : undefined);
  });
}),
```

Note the last line: `refresh` accepts a node, so uploading into a directory item only
refreshes that subtree.

Drag-and-drop uploads (`SftpDragAndDropController`) keep the default: a drop onto an
existing file surfaces the localized conflict error instead of silently overwriting. If a
prompt is wanted there too, wrap the `manager.uploadFile` call in `handleDrop` the same way.

## 3. `extension.ts` — download command handles directories

Add to the imports (aliased because `dirname` from `./sftp/RemotePath` is already imported):

```ts
import { join as joinLocalPath } from 'node:path';
```

Replace the body of the `sshManager.sftp.download` command:

```ts
vscode.commands.registerCommand('sshManager.sftp.download', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
  await runSftpCommand(async () => {
    if (!item) {
      return;
    }
    if (item.entry.type === 'directory' || item.entry.targetType === 'directory') {
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: t('Download Here')
      });
      if (!folders?.length) {
        return;
      }
      await sftpManager.downloadDirectory(item.entry.path, joinLocalPath(folders[0].fsPath, item.entry.name));
      return;
    }
    const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(item.entry.name) });
    if (!destination) {
      return;
    }
    await sftpManager.downloadFile(item.entry.path, destination.fsPath);
  });
}),
```

This fixes the documented failure where "download directory" ran `fastGet` on a directory.
Docs (slice E) may now keep the "download remote file or directory" claim, phrased as
"directory download supported".

## 4. `extension.ts` — delete confirmation shows the entry count

Replace the body of the `sshManager.sftp.delete` command:

```ts
vscode.commands.registerCommand('sshManager.sftp.delete', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
  await runSftpCommand(async () => {
    if (!item) {
      return;
    }
    const deleteAction = t('Delete');
    const message =
      item.entry.type === 'directory'
        ? t('Delete remote directory "{path}"? {count} entries will be permanently deleted.', {
            path: item.entry.path,
            count: await sftpManager.countDeletableEntries(item.entry.path)
          })
        : t('Delete remote {type} "{path}"?', { type: item.entry.type, path: item.entry.path });
    const answer = await vscode.window.showWarningMessage(message, { modal: true }, deleteAction);
    if (answer === deleteAction) {
      await sftpManager.deleteEntry(item.entry);
      sftpTreeProvider.refresh();
    }
  });
}),
```

`countDeletableEntries` includes the directory itself (empty directory → 1). Per the
contract, `sftp_delete` on the agent side is untouched: recursive delete is UI-only and
still confirms every time.

## 5. l10n — new strings for `l10n/bundle.l10n.zh-cn.json` (slice E owns the file)

`test/i18n/nls.test.ts` fails on this branch until these keys land; slice B cannot edit the
bundle. Strings already used by slice B code:

```json
{
  "Remote path already exists: {path}": "远程路径已存在：{path}",
  "Click to preview. Edit opens a local copy that is uploaded back to the server on save.": "单击预览。编辑将打开本地副本，保存时会上传回服务器。",
  "Preview Remote File": "预览远程文件"
}
```

Strings introduced by the `extension.ts` snippets above (add together with the snippets):

```json
{
  "Overwrite": "覆盖",
  "Overwrite All": "全部覆盖",
  "Skip": "跳过",
  "Download Here": "下载到此处",
  "Delete remote directory \"{path}\"? {count} entries will be permanently deleted.": "删除远程目录“{path}”？将永久删除 {count} 个条目。"
}
```

## 6. Behavior notes for the integrator

- `SftpEditSessionManager` (remote edit on save) passes `{ overwrite: true }` explicitly, so
  edit sync is unaffected by the new conflict default.
- Upload/`writeFile` sudo fallback semantics are unchanged; directory uploads never use the
  sudo fallback (a denied write fails with the permission error).
- `downloadDirectory` follows symlinks to files but does not descend into symlinked
  directories (cycle protection); `deleteDirectory` unlinks symlinks without following them.
- Callers that pass `serverId` (edit sessions, agent-facing paths) work with all new methods;
  cache invalidation matches paths across terminals, so two terminals on the same server do
  not serve each other stale listings after a mutation.
