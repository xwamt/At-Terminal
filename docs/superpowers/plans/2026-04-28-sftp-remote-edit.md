# SFTP Remote Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build right-click remote file editing where the selected SFTP file is downloaded to a local cache, opened in VS Code, and synchronized back to the remote file on confirmed saves.

**Architecture:** Keep read-only preview unchanged and add a focused `SftpEditSessionManager` for editable remote file sessions. Reuse the existing `SftpManager` for SFTP connection lifecycle, download, upload, and new remote `stat` operations; keep save-back behavior inside the edit-session manager with injected UI hooks for testability.

**Tech Stack:** VS Code extension API, TypeScript, Node `fs/promises`, Node `crypto`, `ssh2` SFTP, Vitest with the existing `test-fixtures/vscode.ts` mock.

---

## File Structure

- Modify `src/sftp/SftpTypes.ts`
  - Add `SftpFileStat` for remote metadata used by conflict checks.
- Modify `src/sftp/SftpSession.ts`
  - Add `stat(path)` backed by `ssh2` SFTP `stat`.
- Modify `src/sftp/SftpManager.ts`
  - Add `stat(remotePath)` and `getActiveServerId()` for edit sessions.
- Create `src/sftp/SftpEditSessionManager.ts`
  - Own editable local cache paths, session identity, save debounce, upload serialization, conflict checks, status updates, and close cleanup.
- Modify `src/extension.ts`
  - Instantiate `SftpEditSessionManager`, wire VS Code UI hooks, register `sshManager.sftp.edit`, and dispose manager with extension subscriptions.
- Modify `package.json`
  - Contribute `sshManager.sftp.edit` command and show it for connected `sftpFile` context items.
- Modify `test-fixtures/vscode.ts`
  - Add the VS Code APIs needed by tests: `workspace.openTextDocument`, `workspace.onDidSaveTextDocument`, `workspace.onDidCloseTextDocument` event emitters, `window.showTextDocument`, and `window.createStatusBarItem`.
- Modify `test/package.sftp.test.ts`
  - Assert the edit command and context menu contribution.
- Modify `test/sftp/SftpManager.test.ts`
  - Add `stat` to fake sessions and test manager stat/server-id behavior.
- Create `test/sftp/SftpEditSessionManager.test.ts`
  - Test cache path generation, duplicate session reuse, first-save confirmation, debounce, upload serialization, conflict handling, failed upload baseline behavior, ignored unmanaged saves, and close cleanup.
Before implementation, start from a clean branch or worktree. The current planning work was done in the main workspace; implementation should use a `codex/` branch or a dedicated worktree if other local work appears.

---

### Task 1: Add Remote Stat Support

**Files:**
- Modify: `src/sftp/SftpTypes.ts`
- Modify: `src/sftp/SftpSession.ts`
- Modify: `src/sftp/SftpManager.ts`
- Modify: `test/sftp/SftpManager.test.ts`

- [ ] **Step 1: Write the failing manager tests**

Add these cases to `test/sftp/SftpManager.test.ts`. Update every existing fake session in this file to include `stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 }))` so TypeScript accepts the stricter `SftpSessionLike` shape.

```ts
  it('exposes the active connected server id for edit sessions', () => {
    const manager = new SftpManager({ createSession: vi.fn() });

    expect(manager.getActiveServerId()).toBeUndefined();

    manager.setTerminalContext(context(true));
    expect(manager.getActiveServerId()).toBe('srv');

    manager.setTerminalContext(context(false));
    expect(manager.getActiveServerId()).toBeUndefined();
  });

  it('reads remote file stat through the active SFTP session', async () => {
    const stat = vi.fn(async () => ({ size: 128, modifiedAt: 1714280000 }));
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async () => '/home/deploy'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      stat,
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await expect(manager.stat('/home/deploy/app.js')).resolves.toEqual({
      size: 128,
      modifiedAt: 1714280000
    });
    expect(stat).toHaveBeenCalledWith('/home/deploy/app.js');
  });
```

- [ ] **Step 2: Run the failing tests**

Run:

```powershell
npm test -- test/sftp/SftpManager.test.ts
```

Expected: TypeScript or Vitest fails because `SftpManager.getActiveServerId`, `SftpManager.stat`, and `SftpSessionLike.stat` do not exist yet.

- [ ] **Step 3: Add the remote stat type**

Add this interface to `src/sftp/SftpTypes.ts`:

```ts
export interface SftpFileStat {
  size: number;
  modifiedAt: number;
}
```

- [ ] **Step 4: Add stat to SFTP session interface and manager**

Modify `src/sftp/SftpManager.ts`:

```ts
import type { SftpEntry, SftpFileStat } from './SftpTypes';
```

Extend `SftpSessionLike`:

```ts
  stat(path: string): Promise<SftpFileStat>;
```

Add methods to `SftpManager`:

```ts
  getActiveServerId(): string | undefined {
    return this.terminalContext?.connected ? this.terminalContext.server.id : undefined;
  }

  async stat(path: string): Promise<SftpFileStat> {
    if (!this.terminalContext?.connected) {
      throw new Error('No connected SSH terminal is active.');
    }
    return await (await this.ensureSession()).stat(path);
  }
```

Adjust `runConnected` to support mutation and transfer jobs that return a value:

```ts
  private async runConnected<T>(
    label: string,
    job: (session: SftpSessionLike, progress: TransferProgress) => Promise<T>
  ): Promise<T> {
    await this.transfers.requireConnected(Boolean(this.terminalContext?.connected));
    return await this.transfers.run(label, async (progress) => {
      return await job(await this.ensureSession(), progress);
    });
  }
```

- [ ] **Step 5: Implement stat in the real SFTP session**

Modify imports in `src/sftp/SftpSession.ts`:

```ts
import type { PasswordSource, SftpEntry, SftpEntryType, SftpFileStat } from './SftpTypes';
```

Add this method to `SftpSession`:

```ts
  async stat(path: string): Promise<SftpFileStat> {
    const sftp = this.requireSftp();
    const attrs = await new Promise<{ size: number; mtime: number }>((resolve, reject) => {
      sftp.stat(path, (error, stat) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stat);
      });
    });
    return {
      size: attrs.size,
      modifiedAt: attrs.mtime
    };
  }
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
npm test -- test/sftp/SftpManager.test.ts
npm run typecheck
```

Expected: `SftpManager.test.ts` passes and typecheck succeeds.

- [ ] **Step 7: Commit**

```powershell
git add src/sftp/SftpTypes.ts src/sftp/SftpSession.ts src/sftp/SftpManager.ts test/sftp/SftpManager.test.ts
git commit -m "feat: add sftp remote stat support"
```

---

### Task 2: Contribute the Edit Command Surface

**Files:**
- Modify: `package.json`
- Modify: `test/package.sftp.test.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Write failing package contribution assertions**

Modify `test/package.sftp.test.ts` so the command array includes `sshManager.sftp.edit`:

```ts
        'sshManager.sftp.edit',
```

Add a new assertion after the command assertion:

```ts
    expect(pkg.contributes.menus['view/item/context']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'sshManager.sftp.edit',
          when: 'view == sshManager.sftpFiles && viewItem == sftpFile',
          group: 'open@1'
        })
      ])
    );
```

- [ ] **Step 2: Run the failing package test**

Run:

```powershell
npm test -- test/package.sftp.test.ts
```

Expected: FAIL because `sshManager.sftp.edit` is not contributed.

- [ ] **Step 3: Add the package contribution**

Modify `package.json` command list:

```json
{ "command": "sshManager.sftp.edit", "title": "SFTP: Edit" },
{ "command": "sshManager.sftp.openPreview", "title": "SFTP: Open Preview" },
```

Modify the `view/item/context` menu so edit is the first file open action and preview remains available:

```json
{
  "command": "sshManager.sftp.edit",
  "when": "view == sshManager.sftpFiles && viewItem == sftpFile",
  "group": "open@1"
},
{
  "command": "sshManager.sftp.openPreview",
  "when": "view == sshManager.sftpFiles && viewItem == sftpFile",
  "group": "open@2"
},
{
  "command": "sshManager.sftp.cdToDirectory",
  "when": "view == sshManager.sftpFiles && viewItem == sftpDirectory",
  "group": "open@3"
}
```

- [ ] **Step 4: Register a temporary command handler**

Add a temporary command registration in `src/extension.ts` near `openPreview`. This keeps activation command registration complete before the manager exists:

```ts
    vscode.commands.registerCommand('sshManager.sftp.edit', async (item?: SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        if (!item) {
          return;
        }
        await vscode.window.showErrorMessage('SFTP edit is not wired yet.');
      });
    }),
```

This handler will be replaced in Task 6.

- [ ] **Step 5: Run package test and typecheck**

Run:

```powershell
npm test -- test/package.sftp.test.ts
npm run typecheck
```

Expected: package test passes and typecheck succeeds.

- [ ] **Step 6: Commit**

```powershell
git add package.json src/extension.ts test/package.sftp.test.ts
git commit -m "feat: contribute sftp edit command"
```

---

### Task 3: Build Edit Session Cache and Open Flow

**Files:**
- Create: `src/sftp/SftpEditSessionManager.ts`
- Create: `test/sftp/SftpEditSessionManager.test.ts`
- Modify: `test-fixtures/vscode.ts`

- [ ] **Step 1: Extend the VS Code test fixture for document and status APIs**

Modify `test-fixtures/vscode.ts` with these exports and methods:

```ts
export interface TextDocument {
  uri: Uri;
  fileName: string;
  isDirty?: boolean;
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export class StatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  visible = false;

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  dispose(): void {
    this.visible = false;
  }
}
```

Add emitters near the existing `workspace` export:

```ts
const didSaveTextDocument = new EventEmitter<TextDocument>();
const didCloseTextDocument = new EventEmitter<TextDocument>();
```

Extend `workspace`:

```ts
  openTextDocument: async (uri: Uri): Promise<TextDocument> => ({
    uri,
    fileName: uri.fsPath,
    isDirty: false
  }),
  onDidSaveTextDocument: didSaveTextDocument.event,
  onDidCloseTextDocument: didCloseTextDocument.event,
  __fireDidSaveTextDocument: (document: TextDocument) => didSaveTextDocument.fire(document),
  __fireDidCloseTextDocument: (document: TextDocument) => didCloseTextDocument.fire(document),
```

Replace the existing `onDidCloseTextDocument: () => ({ dispose: () => undefined })` fixture property with the event-backed property above so there is only one `onDidCloseTextDocument` key.

Extend `window`:

```ts
  showTextDocument: async (document: TextDocument) => document,
  createStatusBarItem: () => new StatusBarItem(),
```

- [ ] **Step 2: Write failing open-flow tests**

Create `test/sftp/SftpEditSessionManager.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  buildEditSessionKey,
  createEditCacheUri,
  SftpEditSessionManager
} from '../../src/sftp/SftpEditSessionManager';

describe('SftpEditSessionManager open flow', () => {
  it('builds stable session keys and collision-resistant cache paths', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-test-')));
    try {
      expect(buildEditSessionKey('srv', '/etc/hosts')).toBe('srv:/etc/hosts');

      const first = createEditCacheUri(storage, 'srv', '/opt/a/config.json');
      const second = createEditCacheUri(storage, 'srv', '/opt/b/config.json');

      expect(first.fsPath).toContain('sftp-edit');
      expect(first.fsPath).toContain('srv');
      expect(first.fsPath).toContain('config.json');
      expect(second.fsPath).toContain('config.json');
      expect(first.fsPath).not.toBe(second.fsPath);
    } finally {
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('downloads a remote file, opens the cached local file, and reuses duplicate sessions', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-open-')));
    const opened: vscode.Uri[] = [];
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => {
        await writeFile(localPath, 'initial');
      }),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: async (uri) => {
          opened.push(uri);
        },
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const first = await manager.openRemoteFile('/srv/app/index.js');
      const second = await manager.openRemoteFile('/srv/app/index.js');

      expect(first.localUri.fsPath).toBe(second.localUri.fsPath);
      expect(existsSync(first.localUri.fsPath)).toBe(true);
      expect(sftp.downloadFile).toHaveBeenCalledTimes(1);
      expect(sftp.stat).toHaveBeenCalledTimes(1);
      expect(opened).toEqual([first.localUri, first.localUri]);
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Run the failing edit manager tests**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
```

Expected: FAIL because `SftpEditSessionManager` and helper functions do not exist.

- [ ] **Step 4: Implement cache helpers and open flow**

Create `src/sftp/SftpEditSessionManager.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { safePreviewName } from './RemotePath';
import type { SftpFileStat } from './SftpTypes';

export type SftpEditSyncState = 'idle' | 'pending' | 'uploading' | 'conflict' | 'failed';
export type SftpEditConflictChoice = 'overwrite' | 'cancel';
export type SftpEditCloseChoice = 'keep' | 'discard';

export interface SftpEditSftpClient {
  getActiveServerId(): string | undefined;
  stat(remotePath: string): Promise<SftpFileStat>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
}

export interface SftpEditUi {
  openFile(uri: vscode.Uri): Promise<void>;
  confirmAutoSync(remotePath: string): Promise<boolean>;
  resolveConflict(remotePath: string): Promise<SftpEditConflictChoice>;
  showStatus(state: SftpEditSyncState, message: string): void;
  promptUnsyncedClose(remotePath: string): Promise<SftpEditCloseChoice>;
}

export interface SftpEditSession {
  key: string;
  serverId: string;
  remotePath: string;
  localUri: vscode.Uri;
  baseRemoteStat: SftpFileStat;
  firstSaveConfirmed: boolean;
  syncState: SftpEditSyncState;
  uploadInProgress: boolean;
  pendingUpload: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
  lastError: string | undefined;
}

export interface SftpEditSessionManagerOptions {
  storageUri: vscode.Uri;
  sftp: SftpEditSftpClient;
  ui: SftpEditUi;
  debounceMs?: number;
}

export function buildEditSessionKey(serverId: string, remotePath: string): string {
  return `${serverId}:${remotePath}`;
}

export function createEditCacheUri(storageUri: vscode.Uri, serverId: string, remotePath: string): vscode.Uri {
  const hash = createHash('sha256').update(remotePath).digest('hex').slice(0, 16);
  return vscode.Uri.joinPath(storageUri, 'sftp-edit', safePreviewName(serverId), hash, safePreviewName(remotePath));
}

export function remoteStatsMatch(left: SftpFileStat, right: SftpFileStat): boolean {
  return left.size === right.size && left.modifiedAt === right.modifiedAt;
}

export class SftpEditSessionManager {
  private readonly sessionsByKey = new Map<string, SftpEditSession>();
  private readonly sessionsByLocalPath = new Map<string, SftpEditSession>();
  private readonly debounceMs: number;

  constructor(private readonly options: SftpEditSessionManagerOptions) {
    this.debounceMs = options.debounceMs ?? 750;
  }

  async openRemoteFile(remotePath: string): Promise<SftpEditSession> {
    const serverId = this.options.sftp.getActiveServerId();
    if (!serverId) {
      throw new Error('No connected SSH terminal is active.');
    }

    const key = buildEditSessionKey(serverId, remotePath);
    const existing = this.sessionsByKey.get(key);
    if (existing) {
      await this.options.ui.openFile(existing.localUri);
      return existing;
    }

    const localUri = createEditCacheUri(this.options.storageUri, serverId, remotePath);
    await mkdir(dirname(localUri.fsPath), { recursive: true });
    const baseRemoteStat = await this.options.sftp.stat(remotePath);
    await this.options.sftp.downloadFile(remotePath, localUri.fsPath);

    const session: SftpEditSession = {
      key,
      serverId,
      remotePath,
      localUri,
      baseRemoteStat,
      firstSaveConfirmed: false,
      syncState: 'idle',
      uploadInProgress: false,
      pendingUpload: false,
      debounceTimer: undefined,
      lastError: undefined
    };
    this.sessionsByKey.set(key, session);
    this.sessionsByLocalPath.set(localUri.fsPath, session);
    await this.options.ui.openFile(localUri);
    return session;
  }

  getSessionByLocalPath(localPath: string): SftpEditSession | undefined {
    return this.sessionsByLocalPath.get(localPath);
  }

  dispose(): void {
    for (const session of this.sessionsByKey.values()) {
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
      }
    }
    this.sessionsByKey.clear();
    this.sessionsByLocalPath.clear();
  }

  async deleteSessionCache(session: SftpEditSession): Promise<void> {
    await rm(session.localUri.fsPath, { force: true });
  }
}
```

- [ ] **Step 5: Run edit manager tests**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
npm run typecheck
```

Expected: tests pass and typecheck succeeds.

- [ ] **Step 6: Commit**

```powershell
git add src/sftp/SftpEditSessionManager.ts test/sftp/SftpEditSessionManager.test.ts test-fixtures/vscode.ts
git commit -m "feat: add sftp edit session open flow"
```

---

### Task 4: Implement Save Confirmation, Debounce, and Serialized Uploads

**Files:**
- Modify: `src/sftp/SftpEditSessionManager.ts`
- Modify: `test/sftp/SftpEditSessionManager.test.ts`

- [ ] **Step 1: Add failing save synchronization tests**

Append these tests to `test/sftp/SftpEditSessionManager.test.ts`:

```ts
describe('SftpEditSessionManager save synchronization', () => {
  it('ignores unmanaged saved documents', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-unmanaged-')));
    const uploadFile = vi.fn();
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp: {
        getActiveServerId: vi.fn(() => 'srv'),
        stat: vi.fn(),
        downloadFile: vi.fn(),
        uploadFile
      },
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      await manager.handleSavedDocument({ uri: vscode.Uri.file(join(storage.fsPath, 'other.txt')), fileName: 'other.txt' });
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('asks once before enabling automatic upload and then uploads future saves quietly', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-save-')));
    const confirmAutoSync = vi.fn(async () => true);
    const showStatus = vi.fn();
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 25,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync,
        resolveConflict: vi.fn(),
        showStatus,
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(25);

      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(25);

      expect(confirmAutoSync).toHaveBeenCalledTimes(1);
      expect(sftp.uploadFile).toHaveBeenCalledTimes(2);
      expect(sftp.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/srv/app/index.js');
      expect(showStatus).toHaveBeenCalledWith('uploading', 'Uploading remote file...');
      expect(showStatus).toHaveBeenCalledWith('idle', 'Remote file synced');
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('coalesces rapid saves into one upload', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-debounce-')));
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 50,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(25);
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(50);

      expect(sftp.uploadFile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run failing save tests**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
```

Expected: FAIL because `handleSavedDocument` does not exist.

- [ ] **Step 3: Implement save debounce and upload queue**

Add these methods to `SftpEditSessionManager`:

```ts
  async handleSavedDocument(document: vscode.TextDocument): Promise<void> {
    const session = this.sessionsByLocalPath.get(document.uri.fsPath);
    if (!session) {
      return;
    }
    this.scheduleUpload(session);
  }

  private scheduleUpload(session: SftpEditSession): void {
    session.syncState = 'pending';
    session.pendingUpload = true;
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
    }
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = undefined;
      void this.drainUploadQueue(session);
    }, this.debounceMs);
  }

  private async drainUploadQueue(session: SftpEditSession): Promise<void> {
    if (session.uploadInProgress) {
      session.pendingUpload = true;
      return;
    }

    while (session.pendingUpload) {
      session.pendingUpload = false;
      if (!session.firstSaveConfirmed) {
        const confirmed = await this.options.ui.confirmAutoSync(session.remotePath);
        if (!confirmed) {
          session.syncState = 'idle';
          return;
        }
        session.firstSaveConfirmed = true;
      }

      session.uploadInProgress = true;
      session.syncState = 'uploading';
      session.lastError = undefined;
      this.options.ui.showStatus('uploading', 'Uploading remote file...');
      try {
        const uploaded = await this.uploadIfUnchanged(session);
        if (!uploaded) {
          return;
        }
        session.syncState = 'idle';
        this.options.ui.showStatus('idle', 'Remote file synced');
      } catch (error) {
        session.syncState = 'failed';
        session.lastError = error instanceof Error ? error.message : String(error);
        this.options.ui.showStatus('failed', 'Remote sync failed');
      } finally {
        session.uploadInProgress = false;
      }
    }
  }

  private async uploadIfUnchanged(session: SftpEditSession): Promise<boolean> {
    const currentRemoteStat = await this.options.sftp.stat(session.remotePath);
    if (!remoteStatsMatch(currentRemoteStat, session.baseRemoteStat)) {
      session.syncState = 'conflict';
      this.options.ui.showStatus('conflict', 'Remote file changed');
      return false;
    }
    await this.options.sftp.uploadFile(session.localUri.fsPath, session.remotePath);
    session.baseRemoteStat = await this.options.sftp.stat(session.remotePath);
    return true;
  }
```

This initial conflict branch only blocks upload. Task 5 will add the overwrite/cancel prompt.

- [ ] **Step 4: Run save tests and typecheck**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
npm run typecheck
```

Expected: tests pass and typecheck succeeds.

- [ ] **Step 5: Commit**

```powershell
git add src/sftp/SftpEditSessionManager.ts test/sftp/SftpEditSessionManager.test.ts
git commit -m "feat: sync sftp edits on confirmed saves"
```

---

### Task 5: Add Conflict Resolution and Failed Upload Safety

**Files:**
- Modify: `src/sftp/SftpEditSessionManager.ts`
- Modify: `test/sftp/SftpEditSessionManager.test.ts`

- [ ] **Step 1: Add failing conflict tests**

Append these tests to `test/sftp/SftpEditSessionManager.test.ts`:

```ts
describe('SftpEditSessionManager conflicts and failures', () => {
  it('prompts before overwriting when the remote stat changed', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-conflict-')));
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi
        .fn()
        .mockResolvedValueOnce({ size: 7, modifiedAt: 10 })
        .mockResolvedValueOnce({ size: 8, modifiedAt: 11 })
        .mockResolvedValueOnce({ size: 9, modifiedAt: 12 }),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(async () => 'overwrite'),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);

      expect(sftp.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/srv/app/index.js');
      expect(session.baseRemoteStat).toEqual({ size: 9, modifiedAt: 12 });
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('keeps local edits and does not upload when conflict resolution is canceled', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-cancel-conflict-')));
    const showStatus = vi.fn();
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn().mockResolvedValueOnce({ size: 7, modifiedAt: 10 }).mockResolvedValueOnce({ size: 8, modifiedAt: 11 }),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(async () => 'cancel'),
        showStatus,
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);

      expect(sftp.uploadFile).not.toHaveBeenCalled();
      expect(session.syncState).toBe('conflict');
      expect(showStatus).toHaveBeenCalledWith('conflict', 'Remote file changed');
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('does not advance the remote baseline when upload fails', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-failed-')));
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn(async () => {
        throw new Error('permission denied');
      })
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);

      expect(session.syncState).toBe('failed');
      expect(session.lastError).toBe('permission denied');
      expect(session.baseRemoteStat).toEqual({ size: 7, modifiedAt: 10 });
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run failing conflict tests**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
```

Expected: conflict overwrite test fails because conflicts are not resolved through the UI yet.

- [ ] **Step 3: Implement conflict resolution**

Replace `uploadIfUnchanged` in `src/sftp/SftpEditSessionManager.ts` with:

```ts
  private async uploadIfUnchanged(session: SftpEditSession): Promise<boolean> {
    const currentRemoteStat = await this.options.sftp.stat(session.remotePath);
    const conflict = !remoteStatsMatch(currentRemoteStat, session.baseRemoteStat);
    if (conflict) {
      session.syncState = 'conflict';
      this.options.ui.showStatus('conflict', 'Remote file changed');
      const choice = await this.options.ui.resolveConflict(session.remotePath);
      if (choice === 'cancel') {
        return false;
      }
      session.syncState = 'uploading';
    }

    await this.options.sftp.uploadFile(session.localUri.fsPath, session.remotePath);
    session.baseRemoteStat = await this.options.sftp.stat(session.remotePath);
    return true;
  }
```

Adjust `drainUploadQueue` so a canceled conflict remains in `conflict` instead of being reset to `idle`:

```ts
        const uploaded = await this.uploadIfUnchanged(session);
        if (!uploaded) {
          return;
        }
        session.syncState = 'idle';
        this.options.ui.showStatus('idle', 'Remote file synced');
```

- [ ] **Step 4: Run conflict tests and typecheck**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
npm run typecheck
```

Expected: tests pass and typecheck succeeds.

- [ ] **Step 5: Commit**

```powershell
git add src/sftp/SftpEditSessionManager.ts test/sftp/SftpEditSessionManager.test.ts
git commit -m "feat: handle sftp edit save conflicts"
```

---

### Task 6: Wire Edit Sessions Into the Extension

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/sftp/SftpEditSessionManager.ts`
- Modify: `test-fixtures/vscode.ts`

- [ ] **Step 1: Add production VS Code UI adapter helpers**

Add this export to `src/sftp/SftpEditSessionManager.ts`:

```ts
export function createVscodeSftpEditUi(statusBarItem: vscode.StatusBarItem): SftpEditUi {
  return {
    async openFile(uri) {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    },
    async confirmAutoSync(remotePath) {
      const answer = await vscode.window.showWarningMessage(
        `Enable automatic sync to ${remotePath} for this edit session?`,
        { modal: true },
        'Enable Sync'
      );
      return answer === 'Enable Sync';
    },
    async resolveConflict(remotePath) {
      const answer = await vscode.window.showWarningMessage(
        `Remote file changed: ${remotePath}`,
        { modal: true },
        'Overwrite Remote',
        'Cancel Upload'
      );
      return answer === 'Overwrite Remote' ? 'overwrite' : 'cancel';
    },
    showStatus(state, message) {
      statusBarItem.text =
        state === 'uploading'
          ? '$(sync~spin) Uploading remote file...'
          : state === 'idle'
            ? '$(check) Remote file synced'
            : state === 'conflict'
              ? '$(warning) Remote file changed'
              : '$(error) Remote sync failed';
      statusBarItem.tooltip = message;
      statusBarItem.show();
      if (state === 'idle') {
        setTimeout(() => statusBarItem.hide(), 2000);
      }
    },
    async promptUnsyncedClose(remotePath) {
      const answer = await vscode.window.showWarningMessage(
        `Remote edit has unsynchronized changes: ${remotePath}`,
        { modal: true },
        'Keep Local Copy',
        'Discard Local Copy'
      );
      return answer === 'Discard Local Copy' ? 'discard' : 'keep';
    }
  };
}
```

- [ ] **Step 2: Wire constructor subscriptions**

Modify the `SftpEditSessionManager` constructor so it subscribes to VS Code save and close events:

```ts
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(private readonly options: SftpEditSessionManagerOptions) {
    this.debounceMs = options.debounceMs ?? 750;
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.handleSavedDocument(document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        void this.handleClosedDocument(document);
      })
    );
  }
```

Update `dispose`:

```ts
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
```

`handleClosedDocument` will be implemented in Task 7. Add a stub now so typecheck passes:

```ts
  async handleClosedDocument(document: vscode.TextDocument): Promise<void> {
    const session = this.sessionsByLocalPath.get(document.uri.fsPath);
    if (!session) {
      return;
    }
  }
```

- [ ] **Step 3: Replace the temporary command in extension activation**

Modify imports in `src/extension.ts`:

```ts
import { createVscodeSftpEditUi, SftpEditSessionManager } from './sftp/SftpEditSessionManager';
```

Instantiate the manager after `sftpPreviewStore`:

```ts
  const sftpEditStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const sftpEditManager = new SftpEditSessionManager({
    storageUri: context.globalStorageUri,
    sftp: sftpManager,
    ui: createVscodeSftpEditUi(sftpEditStatus)
  });
```

Push the status item and manager into subscriptions:

```ts
    sftpEditStatus,
    sftpEditManager,
```

Replace the temporary `sshManager.sftp.edit` handler with:

```ts
    vscode.commands.registerCommand('sshManager.sftp.edit', async (item?: SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        if (!item) {
          return;
        }
        await sftpEditManager.openRemoteFile(item.entry.path);
      });
    }),
```

- [ ] **Step 4: Update fixture status bar signatures if typecheck requires it**

If TypeScript reports `createStatusBarItem` signature mismatch, modify `test-fixtures/vscode.ts`:

```ts
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) => new StatusBarItem(),
```

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
npm test -- test/package.sftp.test.ts test/sftp/SftpEditSessionManager.test.ts
npm run typecheck
```

Expected: tests pass and typecheck succeeds.

- [ ] **Step 6: Commit**

```powershell
git add src/extension.ts src/sftp/SftpEditSessionManager.ts test-fixtures/vscode.ts
git commit -m "feat: wire sftp edit command"
```

---

### Task 7: Implement Close Cleanup and Cache Safety

**Files:**
- Modify: `src/sftp/SftpEditSessionManager.ts`
- Modify: `test/sftp/SftpEditSessionManager.test.ts`

- [ ] **Step 1: Add failing close cleanup tests**

Append these tests to `test/sftp/SftpEditSessionManager.test.ts`:

```ts
describe('SftpEditSessionManager close cleanup', () => {
  it('deletes cache and unregisters clean idle sessions on close', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-clean-')));
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp: {
        getActiveServerId: vi.fn(() => 'srv'),
        stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
        downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
        uploadFile: vi.fn()
      },
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      expect(existsSync(session.localUri.fsPath)).toBe(true);

      await manager.handleClosedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });

      expect(existsSync(session.localUri.fsPath)).toBe(false);
      expect(manager.getSessionByLocalPath(session.localUri.fsPath)).toBeUndefined();
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('keeps local cache when a failed session is closed and the user chooses keep', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-keep-')));
    const promptUnsyncedClose = vi.fn(async () => 'keep' as const);
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp: {
        getActiveServerId: vi.fn(() => 'srv'),
        stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
        downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
        uploadFile: vi.fn()
      },
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      session.syncState = 'failed';

      await manager.handleClosedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });

      expect(promptUnsyncedClose).toHaveBeenCalledWith('/srv/app/index.js');
      expect(existsSync(session.localUri.fsPath)).toBe(true);
      expect(manager.getSessionByLocalPath(session.localUri.fsPath)).toBe(session);
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('discards local cache when a failed session is closed and the user chooses discard', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-discard-')));
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp: {
        getActiveServerId: vi.fn(() => 'srv'),
        stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
        downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
        uploadFile: vi.fn()
      },
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn(async () => 'discard')
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      session.syncState = 'failed';

      await manager.handleClosedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });

      expect(existsSync(session.localUri.fsPath)).toBe(false);
      expect(manager.getSessionByLocalPath(session.localUri.fsPath)).toBeUndefined();
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run failing cleanup tests**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
```

Expected: cleanup tests fail because `handleClosedDocument` does not unregister or delete cache files.

- [ ] **Step 3: Implement close cleanup**

Add helper methods to `SftpEditSessionManager`:

```ts
  private hasUnsynchronizedState(session: SftpEditSession): boolean {
    return session.syncState === 'pending' || session.syncState === 'uploading' || session.syncState === 'conflict' || session.syncState === 'failed';
  }

  private unregisterSession(session: SftpEditSession): void {
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = undefined;
    }
    this.sessionsByKey.delete(session.key);
    this.sessionsByLocalPath.delete(session.localUri.fsPath);
  }
```

Replace the `handleClosedDocument` stub:

```ts
  async handleClosedDocument(document: vscode.TextDocument): Promise<void> {
    const session = this.sessionsByLocalPath.get(document.uri.fsPath);
    if (!session) {
      return;
    }

    if (this.hasUnsynchronizedState(session)) {
      const choice = await this.options.ui.promptUnsyncedClose(session.remotePath);
      if (choice === 'keep') {
        return;
      }
    }

    this.unregisterSession(session);
    await this.deleteSessionCache(session);
  }
```

Update `dispose` to call `unregisterSession` logic safely:

```ts
    for (const session of this.sessionsByKey.values()) {
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
      }
    }
```

Do not delete files in `dispose`; close handling owns cleanup decisions.

- [ ] **Step 4: Run cleanup tests and typecheck**

Run:

```powershell
npm test -- test/sftp/SftpEditSessionManager.test.ts
npm run typecheck
```

Expected: tests pass and typecheck succeeds.

- [ ] **Step 5: Commit**

```powershell
git add src/sftp/SftpEditSessionManager.ts test/sftp/SftpEditSessionManager.test.ts
git commit -m "feat: clean up sftp edit cache safely"
```

---

### Task 8: Final Verification and Manual Test Notes

**Files:**
- Create: `docs/superpowers/manual-tests/2026-04-28-sftp-remote-edit.md`

- [ ] **Step 1: Add manual test checklist**

Create `docs/superpowers/manual-tests/2026-04-28-sftp-remote-edit.md`:

```md
# SFTP Remote Edit Manual Tests

Date: 2026-04-28

## Setup

- Build the extension with `npm run build`.
- Launch the extension in VS Code Extension Development Host.
- Connect to an SSH server that supports SFTP.
- Open the `SFTP Files` view.

## Cases

- Right-click a remote file and choose `SFTP: Edit`.
- Confirm the file opens as a normal editable VS Code file.
- Save once and confirm the automatic sync prompt appears.
- Choose `Enable Sync` and confirm the remote file is updated.
- Save again and confirm no success notification appears.
- Enable VS Code Auto Save, edit the file repeatedly, and confirm only the final content is uploaded.
- Modify the same remote file outside this editor, save locally, and confirm the conflict prompt appears.
- Choose `Cancel Upload` and confirm local content remains open.
- Save again, choose `Overwrite Remote`, and confirm the remote file matches local content.
- Disconnect the terminal, edit locally, save, and confirm an error status appears without closing the file.
- Reconnect to the same server, save again, and confirm upload can retry.
- Close a clean synced edit document and confirm the local cache file is removed.
- Close an unsynchronized failed edit document and confirm the keep/discard prompt appears.
```

- [ ] **Step 2: Run full automated verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
```

Expected: all tests pass, typecheck succeeds, and build exits with code 0.

- [ ] **Step 3: Inspect git diff**

Run:

```powershell
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows only intentional files from the plan.

- [ ] **Step 4: Commit manual test notes**

Commit the manual test document:

```powershell
git add docs/superpowers/manual-tests/2026-04-28-sftp-remote-edit.md
git commit -m "docs: add sftp remote edit manual tests"
```

If final verification exposes a defect, fix it in the task-owned source or test file, re-run the failing verification command, and commit that concrete fix with a message naming the defect.

- [ ] **Step 5: Report implementation result**

Summarize:

- Commands run and whether they passed.
- Manual tests completed and any skipped cases.
- Files changed.
- Known limitations retained from the spec: no three-way merge, no persistent restore after VS Code restart, no full `FileSystemProvider`.

---

## Self-Review Against Spec

- Right-click `SFTP: Edit`: Task 2 and Task 6.
- Download into extension-owned cache: Task 3.
- Open as normal editable `file:` document: Task 3 and Task 6.
- Track edit sessions: Task 3.
- First-save confirmation: Task 4.
- Future saves auto upload: Task 4.
- Auto Save debounce and serialization: Task 4.
- Remote `mtime/size` conflict check: Task 1 and Task 5.
- Conflict prompt before overwrite: Task 5.
- Lightweight status bar: Task 6.
- Safe cleanup: Task 7.
- Tests and manual verification: Tasks 1-8.

Known retained non-goals from the spec:

- Full `FileSystemProvider` is not implemented.
- Three-way merge is not implemented.
- Cross-restart offline restore is not implemented.
- Directory-level editing is not implemented.
- Large-file partial editing is not implemented.
