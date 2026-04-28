# SFTP and lrzsz File Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a terminal-following SFTP file sidebar with upload/download/file operations, plus lrzsz terminal transfer detection hooks.

**Architecture:** Add an active terminal context publisher to `TerminalPanel`, then build a separate SFTP subsystem that follows that context and exposes a second `SFTP Files` TreeView. SFTP uses independent `ssh2` SFTP channels from the same server config and credentials; lrzsz detection is introduced conservatively behind a terminal output/input bridge so it cannot disrupt normal terminal traffic.

**Tech Stack:** VS Code extension API, TypeScript, Vitest, `ssh2`, xterm.js terminal Webview, Node filesystem APIs.

---

## File Structure

- Create `src/terminal/TerminalContext.ts`: active terminal context model and event emitter.
- Modify `src/webview/TerminalPanel.ts`: publish active terminal state, expose safe terminal write hooks, and route output through lrzsz detector later.
- Create `src/sftp/RemotePath.ts`: POSIX remote path helpers, shell quoting, and safe local filename helpers.
- Create `src/sftp/SftpTypes.ts`: shared SFTP entry, context, operation, and snapshot types.
- Create `src/sftp/SftpSession.ts`: `ssh2` SFTP connection and file operation wrapper.
- Create `src/sftp/SftpManager.ts`: active context tracking, lazy session creation, disconnected snapshot state, and command guards.
- Create `src/tree/SftpTreeItems.ts`: VS Code TreeItem classes for active, disconnected, and placeholder SFTP nodes.
- Create `src/tree/SftpTreeProvider.ts`: lazy SFTP tree loading and refresh behavior.
- Modify `src/extension.ts`: register SFTP TreeView, commands, menus, manager, and terminal context.
- Modify `package.json`: contribute `sshManager.sftpFiles` view, commands, menus, activation event, and drag/drop enablement where supported.
- Create `src/sftp/TransferService.ts`: progress, overwrite policy, upload/download orchestration.
- Create `src/sftp/SftpDragAndDropController.ts`: VS Code TreeView drag/drop bridge for local and Explorer resources.
- Create `src/lrzsz/LrzszDetector.ts`: conservative ZMODEM sequence detector.
- Create `src/lrzsz/LrzszTransfer.ts`: protocol adapter boundary for `rz`/`sz`.
- Modify `test-fixtures/vscode.ts`: add VS Code APIs used by SFTP tests.
- Add tests under `test/terminal`, `test/sftp`, `test/tree`, and `test/lrzsz`.
- Modify `README.md`: document SFTP and lrzsz usage.

---

### Task 1: Active Terminal Context

**Files:**
- Create: `src/terminal/TerminalContext.ts`
- Modify: `src/webview/TerminalPanel.ts`
- Test: `test/terminal/TerminalContext.test.ts`
- Test: `test/webview/TerminalPanel.test.ts`

- [ ] **Step 1: Write failing tests for terminal context state**

```ts
// test/terminal/TerminalContext.test.ts
import { describe, expect, it, vi } from 'vitest';
import { TerminalContextRegistry, type TerminalContext } from '../../src/terminal/TerminalContext';
import type { ServerConfig } from '../../src/config/schema';

function server(id: string): ServerConfig {
  return {
    id,
    label: id,
    host: `${id}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('TerminalContextRegistry', () => {
  it('publishes the active terminal context and connection state', () => {
    const registry = new TerminalContextRegistry();
    const listener = vi.fn();
    registry.onDidChangeActiveContext(listener);

    const context: TerminalContext = {
      terminalId: 'terminal-a',
      server: server('a'),
      connected: true,
      write: vi.fn()
    };

    registry.setActive(context);

    expect(registry.getActive()).toBe(context);
    expect(listener).toHaveBeenCalledWith(context);
  });

  it('keeps the context but marks it disconnected', () => {
    const registry = new TerminalContextRegistry();
    registry.setActive({
      terminalId: 'terminal-a',
      server: server('a'),
      connected: true,
      write: vi.fn()
    });

    registry.markDisconnected('terminal-a');

    expect(registry.getActive()?.connected).toBe(false);
  });

  it('clears only the matching active terminal', () => {
    const registry = new TerminalContextRegistry();
    registry.setActive({
      terminalId: 'terminal-a',
      server: server('a'),
      connected: true,
      write: vi.fn()
    });

    registry.clearIfActive('terminal-b');
    expect(registry.getActive()?.terminalId).toBe('terminal-a');

    registry.clearIfActive('terminal-a');
    expect(registry.getActive()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- test/terminal/TerminalContext.test.ts`

Expected: FAIL with module not found for `src/terminal/TerminalContext`.

- [ ] **Step 3: Implement terminal context registry**

```ts
// src/terminal/TerminalContext.ts
import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';

export interface TerminalContext {
  terminalId: string;
  server: ServerConfig;
  connected: boolean;
  write(data: string): void;
}

export class TerminalContextRegistry {
  private readonly changed = new vscode.EventEmitter<TerminalContext | undefined>();
  readonly onDidChangeActiveContext = this.changed.event;
  private active: TerminalContext | undefined;

  setActive(context: TerminalContext): void {
    this.active = context;
    this.changed.fire(context);
  }

  getActive(): TerminalContext | undefined {
    return this.active;
  }

  markConnected(terminalId: string): void {
    this.updateConnection(terminalId, true);
  }

  markDisconnected(terminalId: string): void {
    this.updateConnection(terminalId, false);
  }

  clearIfActive(terminalId: string): void {
    if (this.active?.terminalId === terminalId) {
      this.active = undefined;
      this.changed.fire(undefined);
    }
  }

  private updateConnection(terminalId: string, connected: boolean): void {
    if (this.active?.terminalId !== terminalId) {
      return;
    }
    this.active = { ...this.active, connected };
    this.changed.fire(this.active);
  }
}
```

- [ ] **Step 4: Wire `TerminalPanel` to the registry**

Change `TerminalPanel.open` signature to accept an optional `TerminalContextRegistry`, generate a `terminalId`, publish context on open/activation, mark connected after `session.connect()`, mark disconnected on disconnect/error, and clear on dispose.

```ts
// src/webview/TerminalPanel.ts additions
import { randomUUID } from 'node:crypto';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';

private readonly terminalId = randomUUID();

// constructor parameter
private readonly terminalContext?: TerminalContextRegistry

// after terminal.bind()
terminal.publishContext(false);

// in connect() after await this.session.connect()
this.terminalContext?.markConnected(this.terminalId);

// in connect() catch
this.terminalContext?.markDisconnected(this.terminalId);

// in disconnect()
this.terminalContext?.markDisconnected(this.terminalId);

private publishContext(connected: boolean): void {
  this.terminalContext?.setActive({
    terminalId: this.terminalId,
    server: this.server,
    connected,
    write: (data) => this.session.write(data)
  });
}
```

In `onDidChangeViewState`, call `this.publishContext(this.session.isConnected())` after adding `isConnected()` in Task 2.

- [ ] **Step 5: Run tests**

Run: `npm run test -- test/terminal/TerminalContext.test.ts test/webview/TerminalPanel.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/terminal/TerminalContext.ts src/webview/TerminalPanel.ts test/terminal/TerminalContext.test.ts test/webview/TerminalPanel.test.ts
git commit -m "feat: track active ssh terminal context"
```

---

### Task 2: SSH Session Connection State and SFTP Connect Primitive

**Files:**
- Modify: `src/ssh/SshSession.ts`
- Create: `src/sftp/SftpTypes.ts`
- Create: `src/sftp/SftpSession.ts`
- Test: `test/ssh/SshSession.test.ts`
- Test: `test/sftp/SftpSession.test.ts`

- [ ] **Step 1: Write failing tests for connection state and config reuse**

```ts
// test/sftp/SftpSession.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildSftpConnectConfig } from '../../src/sftp/SftpSession';
import type { ServerConfig } from '../../src/config/schema';

function server(authType: 'password' | 'privateKey'): ServerConfig {
  return {
    id: 'srv',
    label: 'Server',
    host: 'example.com',
    port: 2222,
    username: 'deploy',
    authType,
    privateKeyPath: authType === 'privateKey' ? 'C:/keys/id_rsa' : undefined,
    keepAliveInterval: 15,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('buildSftpConnectConfig', () => {
  it('uses the stored password for password auth', async () => {
    const config = await buildSftpConnectConfig(server('password'), {
      getPassword: async () => 'secret'
    });

    expect(config).toMatchObject({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      password: 'secret',
      keepaliveInterval: 15000
    });
  });

  it('rejects missing passwords', async () => {
    await expect(
      buildSftpConnectConfig(server('password'), {
        getPassword: async () => undefined
      })
    ).rejects.toThrow('Missing password');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- test/sftp/SftpSession.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Add shared SFTP types**

```ts
// src/sftp/SftpTypes.ts
import type { ServerConfig } from '../config/schema';

export type SftpEntryType = 'file' | 'directory' | 'symlink';

export interface SftpEntry {
  name: string;
  path: string;
  type: SftpEntryType;
  size?: number;
  modifiedAt?: number;
}

export interface SftpSnapshot {
  server: ServerConfig;
  rootPath: string;
  entriesByPath: Map<string, SftpEntry[]>;
  connected: boolean;
}

export interface PasswordSource {
  getPassword(serverId: string): Promise<string | undefined>;
}
```

- [ ] **Step 4: Implement SFTP connection config and session shell**

```ts
// src/sftp/SftpSession.ts
import { readFile } from 'node:fs/promises';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type { ServerConfig } from '../config/schema';
import type { PasswordSource, SftpEntry } from './SftpTypes';

export async function buildSftpConnectConfig(server: ServerConfig, passwords: PasswordSource): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    keepaliveInterval: server.keepAliveInterval * 1000
  };

  if (server.authType === 'password') {
    const password = await passwords.getPassword(server.id);
    if (!password) {
      throw new Error('Missing password. Edit the server configuration and enter a password.');
    }
    return { ...base, password };
  }

  if (!server.privateKeyPath) {
    throw new Error('Missing private key path.');
  }

  return { ...base, privateKey: await readFile(server.privateKeyPath, 'utf8') };
}

export class SftpSession {
  private client: Client | undefined;
  private sftp: SFTPWrapper | undefined;

  constructor(private readonly server: ServerConfig, private readonly passwords: PasswordSource) {}

  async connect(): Promise<void> {
    const client = new Client();
    this.client = client;
    const config = await buildSftpConnectConfig(this.server, this.passwords);
    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect(config);
    });
    this.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
    });
  }

  isConnected(): boolean {
    return Boolean(this.client && this.sftp);
  }

  async realpath(path = '.'): Promise<string> {
    const sftp = this.requireSftp();
    return await new Promise((resolve, reject) => {
      sftp.realpath(path, (error, resolved) => (error ? reject(error) : resolve(resolved)));
    });
  }

  async listDirectory(path: string): Promise<SftpEntry[]> {
    const sftp = this.requireSftp();
    const rows = await new Promise<Parameters<SFTPWrapper['readdir']>[1] extends (...args: infer A) => void ? A[1] : never>(
      (resolve, reject) => {
        sftp.readdir(path, (error, list) => (error ? reject(error) : resolve(list)));
      }
    );
    return rows.map((row) => ({
      name: row.filename,
      path: `${path.replace(/\/+$/, '')}/${row.filename}`,
      type: row.longname.startsWith('d') ? 'directory' : row.longname.startsWith('l') ? 'symlink' : 'file',
      size: row.attrs.size,
      modifiedAt: row.attrs.mtime
    }));
  }

  dispose(): void {
    this.sftp = undefined;
    this.client?.end();
    this.client = undefined;
  }

  private requireSftp(): SFTPWrapper {
    if (!this.sftp) {
      throw new Error('SFTP connection is not available.');
    }
    return this.sftp;
  }
}
```

- [ ] **Step 5: Add `isConnected()` to `SshSession`**

```ts
// src/ssh/SshSession.ts
private connected = false;

// after shell is ready
this.connected = true;

// in dispose()
this.connected = false;

isConnected(): boolean {
  return this.connected;
}
```

- [ ] **Step 6: Run tests**

Run: `npm run test -- test/sftp/SftpSession.test.ts test/ssh/SshSession.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ssh/SshSession.ts src/sftp/SftpTypes.ts src/sftp/SftpSession.ts test/sftp/SftpSession.test.ts test/ssh/SshSession.test.ts
git commit -m "feat: add sftp session primitive"
```

---

### Task 3: Remote Path Helpers

**Files:**
- Create: `src/sftp/RemotePath.ts`
- Test: `test/sftp/RemotePath.test.ts`

- [ ] **Step 1: Write failing path helper tests**

```ts
// test/sftp/RemotePath.test.ts
import { describe, expect, it } from 'vitest';
import { dirname, joinRemotePath, quotePosixShellPath, safePreviewName } from '../../src/sftp/RemotePath';

describe('RemotePath', () => {
  it('joins POSIX remote paths without using Windows separators', () => {
    expect(joinRemotePath('/home/deploy/', 'app.log')).toBe('/home/deploy/app.log');
  });

  it('gets parent directory paths', () => {
    expect(dirname('/home/deploy/app.log')).toBe('/home/deploy');
    expect(dirname('/app.log')).toBe('/');
  });

  it('quotes POSIX shell paths safely', () => {
    expect(quotePosixShellPath("/tmp/it's here")).toBe("'\/tmp\/it'\"'\"'s here'");
  });

  it('sanitizes preview file names', () => {
    expect(safePreviewName('../../etc/passwd')).toBe('passwd');
    expect(safePreviewName('bad:name?.txt')).toBe('bad_name_.txt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- test/sftp/RemotePath.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement helper functions**

```ts
// src/sftp/RemotePath.ts
export function joinRemotePath(parent: string, child: string): string {
  const cleanParent = parent === '/' ? '' : parent.replace(/\/+$/, '');
  return `${cleanParent}/${child.replace(/^\/+/, '')}` || '/';
}

export function dirname(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) {
    return '/';
  }
  return normalized.slice(0, index);
}

export function quotePosixShellPath(path: string): string {
  return `'${path.replaceAll("'", "'\"'\"'")}'`;
}

export function safePreviewName(remotePath: string): string {
  const name = remotePath.split('/').filter(Boolean).pop() || 'remote-file';
  return name.replace(/[<>:"\\|?*\x00-\x1f]/g, '_');
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- test/sftp/RemotePath.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sftp/RemotePath.ts test/sftp/RemotePath.test.ts
git commit -m "feat: add remote path helpers"
```

---

### Task 4: SFTP Tree Items and Provider States

**Files:**
- Create: `src/tree/SftpTreeItems.ts`
- Create: `src/tree/SftpTreeProvider.ts`
- Test: `test/tree/SftpTreeProvider.test.ts`

- [ ] **Step 1: Write failing provider tests**

```ts
// test/tree/SftpTreeProvider.test.ts
import { describe, expect, it } from 'vitest';
import { SftpTreeProvider } from '../../src/tree/SftpTreeProvider';
import { SftpDirectoryTreeItem, SftpFileTreeItem, SftpPlaceholderTreeItem } from '../../src/tree/SftpTreeItems';
import type { SftpEntry } from '../../src/sftp/SftpTypes';

const entries: SftpEntry[] = [
  { name: 'app', path: '/home/deploy/app', type: 'directory' },
  { name: 'readme.txt', path: '/home/deploy/readme.txt', type: 'file', size: 12 }
];

describe('SftpTreeProvider', () => {
  it('shows a placeholder with no active terminal', async () => {
    const provider = new SftpTreeProvider({ getState: () => ({ kind: 'none' }) });
    const children = await provider.getChildren();

    expect(children[0]).toBeInstanceOf(SftpPlaceholderTreeItem);
    expect(children[0].label).toBe('No active SSH terminal');
  });

  it('renders active root entries', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'active', rootPath: '/home/deploy' }),
      listDirectory: async () => entries
    });

    const children = await provider.getChildren();

    expect(children[0]).toBeInstanceOf(SftpDirectoryTreeItem);
    expect(children[1]).toBeInstanceOf(SftpFileTreeItem);
    expect(children.map((child) => child.contextValue)).toEqual(['sftpDirectory', 'sftpFile']);
  });

  it('marks snapshot entries disconnected', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'disconnected', rootPath: '/home/deploy', entries })
    });

    const children = await provider.getChildren();

    expect(children.map((child) => child.contextValue)).toEqual(['sftpDisconnectedDirectory', 'sftpDisconnectedFile']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- test/tree/SftpTreeProvider.test.ts`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement tree items**

```ts
// src/tree/SftpTreeItems.ts
import * as vscode from 'vscode';
import type { SftpEntry } from '../sftp/SftpTypes';

export class SftpPlaceholderTreeItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sftpPlaceholder';
  }
}

export class SftpDirectoryTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: SftpEntry, disconnected = false) {
    super(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = disconnected ? 'sftpDisconnectedDirectory' : 'sftpDirectory';
    this.tooltip = entry.path;
  }
}

export class SftpFileTreeItem extends vscode.TreeItem {
  constructor(public readonly entry: SftpEntry, disconnected = false) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = disconnected ? 'sftpDisconnectedFile' : 'sftpFile';
    this.description = entry.size === undefined ? undefined : `${entry.size} B`;
    this.tooltip = entry.path;
  }
}
```

- [ ] **Step 4: Implement provider states**

```ts
// src/tree/SftpTreeProvider.ts
import * as vscode from 'vscode';
import type { SftpEntry } from '../sftp/SftpTypes';
import { SftpDirectoryTreeItem, SftpFileTreeItem, SftpPlaceholderTreeItem } from './SftpTreeItems';

export type SftpTreeState =
  | { kind: 'none' }
  | { kind: 'active'; rootPath: string }
  | { kind: 'disconnected'; rootPath: string; entries: SftpEntry[] };

export interface SftpTreeSource {
  getState(): SftpTreeState;
  listDirectory?(path: string): Promise<SftpEntry[]>;
}

export type SftpTreeNode = SftpPlaceholderTreeItem | SftpDirectoryTreeItem | SftpFileTreeItem;

export class SftpTreeProvider implements vscode.TreeDataProvider<SftpTreeNode> {
  private readonly changed = new vscode.EventEmitter<SftpTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: SftpTreeSource) {}

  refresh(item?: SftpTreeNode): void {
    this.changed.fire(item);
  }

  getTreeItem(element: SftpTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SftpTreeNode): Promise<SftpTreeNode[]> {
    const state = this.source.getState();
    if (state.kind === 'none') {
      return element ? [] : [new SftpPlaceholderTreeItem('No active SSH terminal')];
    }
    if (state.kind === 'disconnected') {
      return element ? [] : state.entries.map((entry) => this.toTreeItem(entry, true));
    }
    const path = element instanceof SftpDirectoryTreeItem ? element.entry.path : state.rootPath;
    const entries = await this.source.listDirectory?.(path);
    return (entries ?? []).map((entry) => this.toTreeItem(entry, false));
  }

  private toTreeItem(entry: SftpEntry, disconnected: boolean): SftpTreeNode {
    return entry.type === 'directory'
      ? new SftpDirectoryTreeItem(entry, disconnected)
      : new SftpFileTreeItem(entry, disconnected);
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test -- test/tree/SftpTreeProvider.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tree/SftpTreeItems.ts src/tree/SftpTreeProvider.ts test/tree/SftpTreeProvider.test.ts
git commit -m "feat: add sftp tree provider states"
```

---

### Task 5: SFTP Manager and Active Context Follow

**Files:**
- Create: `src/sftp/SftpManager.ts`
- Modify: `src/tree/SftpTreeProvider.ts`
- Test: `test/sftp/SftpManager.test.ts`

- [ ] **Step 1: Write failing manager tests**

```ts
// test/sftp/SftpManager.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SftpManager } from '../../src/sftp/SftpManager';
import type { TerminalContext } from '../../src/terminal/TerminalContext';

function context(connected: boolean): TerminalContext {
  return {
    terminalId: 'terminal-a',
    connected,
    write: vi.fn(),
    server: {
      id: 'srv',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 1
    }
  };
}

describe('SftpManager', () => {
  it('starts with no active state', () => {
    const manager = new SftpManager({ createSession: vi.fn() });
    expect(manager.getState()).toEqual({ kind: 'none' });
  });

  it('follows a connected terminal and resolves root lazily', async () => {
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async () => '/home/deploy'),
      listDirectory: vi.fn(async () => []),
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    expect(await manager.ensureRoot()).toBe('/home/deploy');
    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/home/deploy' });
  });

  it('keeps a disconnected snapshot', async () => {
    const manager = new SftpManager({ createSession: vi.fn() });
    manager.setSnapshot('/home/deploy', [{ name: 'app', path: '/home/deploy/app', type: 'directory' }]);
    manager.setTerminalContext(context(false));

    expect(manager.getState()).toEqual({
      kind: 'disconnected',
      rootPath: '/home/deploy',
      entries: [{ name: 'app', path: '/home/deploy/app', type: 'directory' }]
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- test/sftp/SftpManager.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement manager**

```ts
// src/sftp/SftpManager.ts
import type { SftpEntry } from './SftpTypes';
import type { TerminalContext } from '../terminal/TerminalContext';
import type { SftpTreeState } from '../tree/SftpTreeProvider';

export interface SftpSessionLike {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  dispose(): void;
}

export interface SftpManagerOptions {
  createSession(context: TerminalContext): SftpSessionLike;
}

export class SftpManager {
  private terminalContext: TerminalContext | undefined;
  private session: SftpSessionLike | undefined;
  private rootPath: string | undefined;
  private snapshot: { rootPath: string; entries: SftpEntry[] } | undefined;

  constructor(private readonly options: SftpManagerOptions) {}

  setTerminalContext(context: TerminalContext | undefined): void {
    this.terminalContext = context;
    if (!context?.connected) {
      this.session?.dispose();
      this.session = undefined;
      return;
    }
    this.rootPath = undefined;
    this.session?.dispose();
    this.session = undefined;
  }

  getState(): SftpTreeState {
    if (!this.terminalContext) {
      return { kind: 'none' };
    }
    if (!this.terminalContext.connected) {
      return this.snapshot
        ? { kind: 'disconnected', rootPath: this.snapshot.rootPath, entries: this.snapshot.entries }
        : { kind: 'none' };
    }
    return { kind: 'active', rootPath: this.rootPath ?? '.' };
  }

  async ensureRoot(): Promise<string> {
    const session = await this.ensureSession();
    this.rootPath = await session.realpath('.');
    return this.rootPath;
  }

  async listDirectory(path?: string): Promise<SftpEntry[]> {
    const root = this.rootPath ?? (await this.ensureRoot());
    const entries = await (await this.ensureSession()).listDirectory(path ?? root);
    if ((path ?? root) === root) {
      this.setSnapshot(root, entries);
    }
    return entries;
  }

  setSnapshot(rootPath: string, entries: SftpEntry[]): void {
    this.snapshot = { rootPath, entries };
  }

  private async ensureSession(): Promise<SftpSessionLike> {
    if (!this.terminalContext?.connected) {
      throw new Error('No connected SSH terminal is active.');
    }
    if (!this.session) {
      this.session = this.options.createSession(this.terminalContext);
      await this.session.connect();
    }
    return this.session;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- test/sftp/SftpManager.test.ts test/tree/SftpTreeProvider.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sftp/SftpManager.ts src/tree/SftpTreeProvider.ts test/sftp/SftpManager.test.ts
git commit -m "feat: make sftp tree follow active terminal"
```

---

### Task 6: VS Code Contributions and Command Registration

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`
- Test: `test/package.sftp.test.ts`

- [ ] **Step 1: Write package contribution test**

```ts
// test/package.sftp.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('SFTP package contributions', () => {
  it('contributes the SFTP Files view and commands', () => {
    expect(pkg.contributes.views.sshManager).toContainEqual({
      id: 'sshManager.sftpFiles',
      name: 'SFTP Files'
    });
    expect(pkg.contributes.commands.map((entry: { command: string }) => entry.command)).toEqual(
      expect.arrayContaining([
        'sshManager.sftp.refresh',
        'sshManager.sftp.upload',
        'sshManager.sftp.download',
        'sshManager.sftp.delete',
        'sshManager.sftp.rename',
        'sshManager.sftp.newFolder',
        'sshManager.sftp.copyPath',
        'sshManager.sftp.openPreview',
        'sshManager.sftp.cdToDirectory'
      ])
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- test/package.sftp.test.ts`

Expected: FAIL because SFTP view is not contributed.

- [ ] **Step 3: Add package contributions**

Add to `activationEvents`:

```json
"onView:sshManager.sftpFiles"
```

Add to `contributes.views.sshManager`:

```json
{ "id": "sshManager.sftpFiles", "name": "SFTP Files" }
```

Add commands:

```json
{ "command": "sshManager.sftp.refresh", "title": "SFTP: Refresh" },
{ "command": "sshManager.sftp.upload", "title": "SFTP: Upload" },
{ "command": "sshManager.sftp.download", "title": "SFTP: Download" },
{ "command": "sshManager.sftp.delete", "title": "SFTP: Delete" },
{ "command": "sshManager.sftp.rename", "title": "SFTP: Rename" },
{ "command": "sshManager.sftp.newFolder", "title": "SFTP: New Folder" },
{ "command": "sshManager.sftp.copyPath", "title": "SFTP: Copy Remote Path" },
{ "command": "sshManager.sftp.openPreview", "title": "SFTP: Open Preview" },
{ "command": "sshManager.sftp.cdToDirectory", "title": "SFTP: cd To Directory" }
```

Add `view/item/context` menu entries scoped to `view == sshManager.sftpFiles` and context values from Task 4.

- [ ] **Step 4: Register SFTP provider and placeholder commands**

In `src/extension.ts`, instantiate:

```ts
const terminalContext = new TerminalContextRegistry();
const sftpManager = new SftpManager({
  createSession: (terminal) => new SftpSession(terminal.server, configManager)
});
const sftpTreeProvider = new SftpTreeProvider({
  getState: () => sftpManager.getState(),
  listDirectory: (path) => sftpManager.listDirectory(path)
});
terminalContext.onDidChangeActiveContext((context) => {
  sftpManager.setTerminalContext(context);
  sftpTreeProvider.refresh();
});
```

Pass `terminalContext` to `TerminalPanel.open`.

Register `sshManager.sftp.refresh` to call `sftpTreeProvider.refresh()`. Register the other SFTP command ids to call a local helper named `showSftpUnavailable(commandName)` until Task 7 replaces each handler with the real behavior:

```ts
function showSftpUnavailable(commandName: string): Thenable<string | undefined> {
  return vscode.window.showInformationMessage(`${commandName} requires the SFTP operations task to be completed.`);
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test -- test/package.sftp.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json src/extension.ts test/package.sftp.test.ts
git commit -m "feat: contribute sftp files view"
```

---

### Task 7: Core File Operations and Progress

**Files:**
- Modify: `src/sftp/SftpSession.ts`
- Create: `src/sftp/TransferService.ts`
- Modify: `src/sftp/SftpManager.ts`
- Modify: `src/extension.ts`
- Test: `test/sftp/TransferService.test.ts`

- [ ] **Step 1: Write transfer service tests**

```ts
// test/sftp/TransferService.test.ts
import { describe, expect, it, vi } from 'vitest';
import { TransferService } from '../../src/sftp/TransferService';

describe('TransferService', () => {
  it('serializes transfer jobs', async () => {
    const order: string[] = [];
    const service = new TransferService();

    await Promise.all([
      service.run('first', async () => {
        order.push('first');
      }),
      service.run('second', async () => {
        order.push('second');
      })
    ]);

    expect(order).toEqual(['first', 'second']);
  });

  it('rejects disconnected operations with a readable error', async () => {
    const service = new TransferService();

    await expect(service.requireConnected(false)).rejects.toThrow('No connected SSH terminal is active.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- test/sftp/TransferService.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 3: Implement transfer service**

```ts
// src/sftp/TransferService.ts
export type TransferJob<T> = () => Promise<T>;

export class TransferService {
  private queue = Promise.resolve();

  async requireConnected(connected: boolean): Promise<void> {
    if (!connected) {
      throw new Error('No connected SSH terminal is active.');
    }
  }

  run<T>(_label: string, job: TransferJob<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
```

- [ ] **Step 4: Add SFTP file operations**

Add methods to `SftpSession`:

```ts
async mkdir(path: string): Promise<void>;
async rename(oldPath: string, newPath: string): Promise<void>;
async deleteFile(path: string): Promise<void>;
async deleteDirectory(path: string): Promise<void>;
async uploadFile(localPath: string, remotePath: string): Promise<void>;
async downloadFile(remotePath: string, localPath: string): Promise<void>;
```

Each method should call the corresponding `SFTPWrapper` method: `mkdir`, `rename`, `unlink`, `rmdir`, `fastPut`, `fastGet`. Wrap callbacks in `Promise`.

- [ ] **Step 5: Replace placeholder command handlers**

In `src/extension.ts`, implement:

- `copyPath`: write selected `entry.path` to clipboard.
- `cdToDirectory`: call active terminal context `write(\`cd ${quotePosixShellPath(path)}\r\`)`.
- `newFolder`: prompt with `showInputBox`, then `sftpManager.mkdir`.
- `rename`: prompt for a new basename, then `sftpManager.rename`.
- `delete`: confirm with modal warning, then delete file or directory.
- `upload`: use `showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true })`.
- `download`: use `showSaveDialog` for files and `showOpenDialog({ canSelectFolders: true })` for directories.
- `openPreview`: download to `context.globalStorageUri` or `context.storageUri` temp area and execute `vscode.open`.

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run test -- test/sftp/TransferService.test.ts test/sftp/SftpManager.test.ts`

Expected: PASS.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sftp/SftpSession.ts src/sftp/SftpManager.ts src/sftp/TransferService.ts src/extension.ts test/sftp/TransferService.test.ts
git commit -m "feat: add sftp file operations"
```

---

### Task 8: Drag-and-Drop Upload

**Files:**
- Create: `src/sftp/SftpDragAndDropController.ts`
- Modify: `src/extension.ts`
- Modify: `test-fixtures/vscode.ts`
- Test: `test/sftp/SftpDragAndDropController.test.ts`

- [ ] **Step 1: Write drag/drop payload tests**

```ts
// test/sftp/SftpDragAndDropController.test.ts
import { describe, expect, it, vi } from 'vitest';
import { collectDraggedUris } from '../../src/sftp/SftpDragAndDropController';

describe('collectDraggedUris', () => {
  it('reads uri-list payloads', async () => {
    const item = { asString: async () => 'file:///C:/project/a.txt\r\nfile:///C:/project/b.txt' };
    const dataTransfer = new Map([['text/uri-list', item]]);

    expect(await collectDraggedUris(dataTransfer as never)).toEqual(['file:///C:/project/a.txt', 'file:///C:/project/b.txt']);
  });

  it('ignores comments and empty lines', async () => {
    const item = { asString: async () => '# comment\r\n\r\nfile:///C:/project/a.txt' };
    const dataTransfer = new Map([['text/uri-list', item]]);

    expect(await collectDraggedUris(dataTransfer as never)).toEqual(['file:///C:/project/a.txt']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- test/sftp/SftpDragAndDropController.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement drag/drop controller helper**

```ts
// src/sftp/SftpDragAndDropController.ts
import * as vscode from 'vscode';
import { dirname } from './RemotePath';
import type { SftpDirectoryTreeItem, SftpFileTreeItem } from '../tree/SftpTreeItems';

export async function collectDraggedUris(dataTransfer: vscode.DataTransfer): Promise<string[]> {
  const item = dataTransfer.get('text/uri-list');
  if (!item) {
    return [];
  }
  const text = await item.asString();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function resolveDropTargetPath(target: SftpDirectoryTreeItem | SftpFileTreeItem | undefined, rootPath: string): string {
  if (!target) {
    return rootPath;
  }
  return target.contextValue === 'sftpFile' ? dirname(target.entry.path) : target.entry.path;
}
```

Then add a `vscode.TreeDragAndDropController` class that calls `sftpManager.uploadUris(uris, targetPath)` in `handleDrop`.

- [ ] **Step 4: Register drag/drop controller**

Pass `dragAndDropController` to `vscode.window.createTreeView('sshManager.sftpFiles', { treeDataProvider, dragAndDropController })`.

- [ ] **Step 5: Run tests**

Run: `npm run test -- test/sftp/SftpDragAndDropController.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sftp/SftpDragAndDropController.ts src/extension.ts test-fixtures/vscode.ts test/sftp/SftpDragAndDropController.test.ts
git commit -m "feat: support sftp drag upload"
```

---

### Task 9: lrzsz Detector Boundary

**Files:**
- Create: `src/lrzsz/LrzszDetector.ts`
- Create: `src/lrzsz/LrzszTransfer.ts`
- Modify: `src/webview/TerminalPanel.ts`
- Test: `test/lrzsz/LrzszDetector.test.ts`

- [ ] **Step 1: Write detector tests**

```ts
// test/lrzsz/LrzszDetector.test.ts
import { describe, expect, it, vi } from 'vitest';
import { LrzszDetector } from '../../src/lrzsz/LrzszDetector';

describe('LrzszDetector', () => {
  it('passes normal terminal output through', () => {
    const detector = new LrzszDetector({ onTransfer: vi.fn() });
    expect(detector.inspect('hello\r\n')).toEqual({ passthrough: 'hello\r\n' });
  });

  it('detects a ZMODEM receive sequence conservatively', () => {
    const onTransfer = vi.fn();
    const detector = new LrzszDetector({ onTransfer });

    const result = detector.inspect('**\x18B00000000000000');

    expect(result.passthrough).toBe('');
    expect(onTransfer).toHaveBeenCalledWith({ direction: 'download' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- test/lrzsz/LrzszDetector.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement conservative detector**

```ts
// src/lrzsz/LrzszDetector.ts
export type LrzszDirection = 'upload' | 'download';

export interface LrzszTransferStart {
  direction: LrzszDirection;
}

export class LrzszDetector {
  constructor(private readonly events: { onTransfer(start: LrzszTransferStart): void }) {}

  inspect(data: string): { passthrough: string } {
    if (data.includes('**\x18B')) {
      this.events.onTransfer({ direction: 'download' });
      return { passthrough: '' };
    }
    if (data.includes('\x18B0100000023be50')) {
      this.events.onTransfer({ direction: 'upload' });
      return { passthrough: '' };
    }
    return { passthrough: data };
  }
}
```

```ts
// src/lrzsz/LrzszTransfer.ts
import * as vscode from 'vscode';
import type { LrzszTransferStart } from './LrzszDetector';

export class LrzszTransfer {
  async start(start: LrzszTransferStart): Promise<void> {
    await vscode.window.showInformationMessage(`lrzsz ${start.direction} detected. Waiting for protocol adapter validation.`);
  }
}
```

- [ ] **Step 4: Route terminal output through detector**

In `TerminalPanel.createSession()`:

```ts
const lrzszDetector = new LrzszDetector({
  onTransfer: (start) => {
    void new LrzszTransfer().start(start);
  }
});

output: (data) => {
  const inspected = lrzszDetector.inspect(data);
  if (inspected.passthrough) {
    void this.panel.webview.postMessage({ type: 'output', payload: inspected.passthrough });
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test -- test/lrzsz/LrzszDetector.test.ts test/webview/TerminalPanel.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lrzsz/LrzszDetector.ts src/lrzsz/LrzszTransfer.ts src/webview/TerminalPanel.ts test/lrzsz/LrzszDetector.test.ts
git commit -m "feat: detect lrzsz terminal transfers"
```

---

### Task 10: Documentation, Build, and Manual Test Notes

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/manual-tests/2026-04-28-sftp-lrzsz.md`

- [ ] **Step 1: Update README usage**

Add a section:

```markdown
## SFTP Files

Open an SSH terminal from the Servers view. The `SFTP Files` view follows the active terminal tab and shows the remote login directory. Use the context menu to refresh, upload, download, rename, delete, create folders, copy paths, preview files, or send `cd` commands to the active terminal.

Drag files or folders from VS Code Explorer into `SFTP Files` to upload them to the target remote directory. Transfer progress appears in VS Code notifications.

## lrzsz

When the remote host has `lrzsz` installed, run `rz` or `sz <file>` in the terminal. The extension detects supported transfer sequences and starts the local upload or download flow.
```

- [ ] **Step 2: Add manual test checklist**

```markdown
# SFTP and lrzsz Manual Test Checklist

Date: 2026-04-28

- [ ] Connect with password auth.
- [ ] Connect with private key auth.
- [ ] Confirm `SFTP Files` follows the active terminal.
- [ ] Browse the login directory.
- [ ] Refresh a directory.
- [ ] Upload one file.
- [ ] Upload one folder.
- [ ] Download one file.
- [ ] Download one folder.
- [ ] Rename a file.
- [ ] Create a folder.
- [ ] Delete a file after confirmation.
- [ ] Copy a remote path.
- [ ] Preview a file read-only.
- [ ] Send `cd` to the active terminal.
- [ ] Drag upload from VS Code Explorer.
- [ ] Disconnect terminal and confirm the last file tree remains visible with write actions disabled.
- [ ] Run `rz` and confirm the detector starts upload flow.
- [ ] Run `sz <file>` and confirm the detector starts download flow.
```

- [ ] **Step 3: Run full verification**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/manual-tests/2026-04-28-sftp-lrzsz.md
git commit -m "docs: document sftp and lrzsz workflows"
```

---

## Self-Review

- Spec coverage: Tasks cover active terminal following, SFTP view, disconnected snapshots, file operations, drag upload, progress serialization, lrzsz detection boundary, tests, and docs.
- Deferred scope preserved: remote save-back editing, persistent transfer queue, remote internal move, permission editing, archive operations, and full lrzsz resume/history are not implemented in this plan.
- Implementation risk called out: lrzsz protocol support starts with detection and an adapter boundary; full protocol library validation can happen inside Task 9 without blocking Tasks 1-8.
- Verification: final task requires `npm run typecheck`, `npm test`, and `npm run build`.
