# SSH Terminal Manager MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the MVP VS Code extension defined in `docs/superpowers/specs/2026-04-28-ssh-terminal-manager-mvp-design.md`.

**Architecture:** The extension uses VS Code TreeView and Webview panels for UI, `globalState` plus `SecretStorage` for persistence, and one independent `ssh2` client per terminal tab. There is no shared connection pool, no jump host support, no SSH agent support, no automatic reconnect, and no SSH config import in the MVP.

**Tech Stack:** VS Code Extension API, TypeScript 5, esbuild, Vitest, `@vscode/test-electron`, `ssh2`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `zod`.

---

## File Structure

Create this project structure:

```text
ssh-plugins/
|-- package.json
|-- tsconfig.json
|-- esbuild.config.mjs
|-- vitest.config.ts
|-- .gitignore
|-- README.md
|-- media/
|   `-- terminal.svg
|-- src/
|   |-- extension.ts
|   |-- config/
|   |   |-- ConfigManager.ts
|   |   `-- schema.ts
|   |-- ssh/
|   |   |-- HostKeyStore.ts
|   |   `-- SshSession.ts
|   |-- tree/
|   |   |-- ServerTreeProvider.ts
|   |   `-- TreeItems.ts
|   |-- utils/
|   |   |-- errors.ts
|   |   |-- nonce.ts
|   |   `-- redaction.ts
|   `-- webview/
|       |-- html.ts
|       |-- ServerFormPanel.ts
|       `-- TerminalPanel.ts
|-- webview/
|   |-- server-form/
|   |   |-- index.css
|   |   `-- index.ts
|   `-- terminal/
|       |-- index.css
|       `-- index.ts
|-- test/
|   |-- config/
|   |   |-- ConfigManager.test.ts
|   |   `-- schema.test.ts
|   |-- ssh/
|   |   `-- HostKeyStore.test.ts
|   |-- tree/
|   |   `-- ServerTreeProvider.test.ts
|   `-- utils/
|       `-- redaction.test.ts
`-- test-fixtures/
    `-- vscode.ts
```

Responsibility boundaries:

- `src/config/*`: validation, config storage, password SecretStorage keys.
- `src/tree/*`: TreeView grouping and item definitions only.
- `src/ssh/*`: host key trust and per-tab SSH lifecycle.
- `src/webview/*`: VS Code-side WebviewPanel creation and message routing.
- `webview/*`: browser-side form and terminal code.
- `src/utils/*`: small pure helpers.

## Task 1: Initialize Project Scaffold

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.config.mjs`
- Create: `vitest.config.ts`
- Create: `README.md`
- Create: `media/terminal.svg`

- [ ] **Step 1: Initialize git repository**

Run:

```powershell
git init
```

Expected: repository initialized in `C:\Users\alan\Desktop\ssh-plugins`.

- [ ] **Step 2: Create `.gitignore`**

Create `.gitignore` with:

```gitignore
node_modules/
dist/
out/
.vscode-test/
coverage/
*.vsix
```

- [ ] **Step 3: Create `package.json`**

Create `package.json` with:

```json
{
  "name": "ssh-terminal-manager",
  "displayName": "SSH Terminal Manager",
  "description": "Manage SSH terminal sessions in VS Code without installing a remote server.",
  "version": "0.1.0",
  "publisher": "local",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "activationEvents": ["onView:sshManager.servers"],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "sshManager",
          "title": "SSH",
          "icon": "media/terminal.svg"
        }
      ]
    },
    "views": {
      "sshManager": [
        {
          "id": "sshManager.servers",
          "name": "Servers"
        }
      ]
    },
    "commands": [
      { "command": "sshManager.addServer", "title": "SSH: Add Server" },
      { "command": "sshManager.editServer", "title": "SSH: Edit Server" },
      { "command": "sshManager.deleteServer", "title": "SSH: Delete Server" },
      { "command": "sshManager.connect", "title": "SSH: Connect" },
      { "command": "sshManager.disconnect", "title": "SSH: Disconnect" },
      { "command": "sshManager.reconnect", "title": "SSH: Reconnect" },
      { "command": "sshManager.copyHost", "title": "SSH: Copy Host" },
      { "command": "sshManager.refresh", "title": "SSH: Refresh" }
    ],
    "menus": {
      "view/title": [
        {
          "command": "sshManager.addServer",
          "when": "view == sshManager.servers",
          "group": "navigation"
        },
        {
          "command": "sshManager.refresh",
          "when": "view == sshManager.servers",
          "group": "navigation"
        }
      ],
      "view/item/context": [
        {
          "command": "sshManager.connect",
          "when": "view == sshManager.servers && viewItem == server",
          "group": "inline@1"
        },
        {
          "command": "sshManager.editServer",
          "when": "view == sshManager.servers && viewItem == server",
          "group": "management@1"
        },
        {
          "command": "sshManager.deleteServer",
          "when": "view == sshManager.servers && viewItem == server",
          "group": "management@2"
        },
        {
          "command": "sshManager.copyHost",
          "when": "view == sshManager.servers && viewItem == server",
          "group": "management@3"
        }
      ]
    },
    "configuration": {
      "title": "SSH Terminal Manager",
      "properties": {
        "sshManager.terminalFontSize": {
          "type": "number",
          "default": 14,
          "minimum": 8
        },
        "sshManager.terminalFontFamily": {
          "type": "string",
          "default": "Cascadia Code, Menlo, monospace"
        },
        "sshManager.scrollback": {
          "type": "number",
          "default": 5000,
          "minimum": 100
        },
        "sshManager.keepAliveInterval": {
          "type": "number",
          "default": 30,
          "minimum": 0
        }
      }
    }
  },
  "scripts": {
    "build": "node esbuild.config.mjs",
    "watch": "node esbuild.config.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/addon-web-links": "^0.11.0",
    "@xterm/xterm": "^5.5.0",
    "ssh2": "^1.16.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^20.19.0",
    "@types/ssh2": "^1.15.5",
    "@types/vscode": "^1.85.0",
    "@vscode/test-electron": "^2.5.2",
    "esbuild": "^0.25.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

- [ ] **Step 4: Create TypeScript and build configs**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "rootDir": ".",
    "types": ["node", "vscode", "vitest/globals"]
  },
  "include": ["src", "webview", "test", "*.ts", "*.mjs"]
}
```

Create `esbuild.config.mjs`:

```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  minify: false
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode']
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/terminal/index.ts'],
    outfile: 'dist/webview/terminal.js',
    platform: 'browser',
    format: 'iife'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/server-form/index.ts'],
    outfile: 'dist/webview/server-form.js',
    platform: 'browser',
    format: 'iife'
  })
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension and webview bundles...');
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
```

Create `vitest.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts']
  },
  resolve: {
    alias: {
      vscode: resolve(root, 'test-fixtures/vscode.ts')
    }
  }
});
```

Create `README.md`:

```md
# SSH Terminal Manager

Lightweight VS Code extension for managing direct SSH terminal sessions.

MVP scope:

- Manual server management.
- Password and private key authentication.
- One independent SSH client per terminal tab.
- xterm.js Webview terminal.
- Manual disconnect and reconnect.
- Basic host fingerprint trust.
```

Create `media/terminal.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c5c5c5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="m4 17 6-6-6-6"/>
  <path d="M12 19h8"/>
</svg>
```

- [ ] **Step 5: Install dependencies**

Run:

```powershell
npm install
```

Expected: `node_modules` and `package-lock.json` are created.

- [ ] **Step 6: Run initial checks**

Run:

```powershell
npm run typecheck
npm test
```

Expected: typecheck fails because source files are not created yet, and tests report no tests or missing config depending on Vitest behavior. Continue to Task 2.

- [ ] **Step 7: Commit scaffold**

Run:

```powershell
git add .gitignore package.json package-lock.json tsconfig.json esbuild.config.mjs vitest.config.ts README.md media/terminal.svg docs/superpowers/specs/2026-04-28-ssh-terminal-manager-mvp-design.md docs/superpowers/plans/2026-04-28-ssh-terminal-manager-mvp.md
git commit -m "chore: scaffold ssh terminal manager project"
```

Expected: commit succeeds.

## Task 2: Add Pure Utilities and VS Code Test Fixture

**Files:**
- Create: `test-fixtures/vscode.ts`
- Create: `src/utils/nonce.ts`
- Create: `src/utils/redaction.ts`
- Create: `src/utils/errors.ts`
- Test: `test/utils/redaction.test.ts`

- [ ] **Step 1: Write failing utility tests**

Create `test/utils/redaction.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { redactSensitiveText, toUserMessage } from '../../src/utils/redaction';

describe('redaction utilities', () => {
  it('redacts passwords and private key blocks from text', () => {
    const input = 'password=secret -----BEGIN OPENSSH PRIVATE KEY----- abc';
    expect(redactSensitiveText(input)).toBe('password=[REDACTED] [REDACTED_PRIVATE_KEY]');
  });

  it('formats unknown errors without leaking raw objects', () => {
    expect(toUserMessage(new Error('connect failed'))).toBe('connect failed');
    expect(toUserMessage({ message: 'custom failure' })).toBe('custom failure');
    expect(toUserMessage(42)).toBe('Unexpected error');
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```powershell
npm test -- test/utils/redaction.test.ts
```

Expected: FAIL because `src/utils/redaction.ts` does not exist.

- [ ] **Step 3: Add VS Code fixture and utilities**

Create `test-fixtures/vscode.ts`:

```ts
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export class TreeItem {
  label?: string;
  collapsibleState?: TreeItemCollapsibleState;
  contextValue?: string;
  command?: unknown;

  constructor(label?: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];
  event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      }
    };
  };
  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  constructor(public readonly fsPath: string) {}
  static file(path: string): Uri {
    return new Uri(path);
  }
  static joinPath(base: Uri, ...paths: string[]): Uri {
    return new Uri([base.fsPath, ...paths].join('/'));
  }
}

export const ThemeIcon = class {
  constructor(public readonly id: string) {}
};

export const window = {
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  createTreeView: () => ({ dispose: () => undefined }),
  createWebviewPanel: () => ({ dispose: () => undefined })
};

export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: async () => undefined
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue
  })
};

export enum ViewColumn {
  Active = -1,
  Beside = -2
}
```

Create `src/utils/nonce.ts`:

```ts
import { randomBytes } from 'node:crypto';

export function createNonce(): string {
  return randomBytes(16).toString('base64url');
}
```

Create `src/utils/redaction.ts`:

```ts
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g;
const PASSWORD_PATTERN = /(password\s*=\s*)([^\s]+)/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(PASSWORD_PATTERN, '$1[REDACTED]');
}

export function toUserMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? redactSensitiveText(message) : 'Unexpected error';
  }
  return 'Unexpected error';
}
```

Create `src/utils/errors.ts`:

```ts
import { toUserMessage } from './redaction';

export class UserVisibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserVisibleError';
  }
}

export function formatError(error: unknown): string {
  return toUserMessage(error);
}
```

- [ ] **Step 4: Verify utility tests pass**

Run:

```powershell
npm test -- test/utils/redaction.test.ts
npm run typecheck
```

Expected: utility tests PASS. Typecheck may still fail until extension files exist; record the missing-file errors and continue.

- [ ] **Step 5: Commit utilities**

Run:

```powershell
git add test-fixtures/vscode.ts src/utils test/utils/redaction.test.ts
git commit -m "chore: add utility helpers"
```

Expected: commit succeeds.

## Task 3: Implement Server Schema

**Files:**
- Create: `src/config/schema.ts`
- Test: `test/config/schema.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `test/config/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseServerConfig, serverConfigSchema } from '../../src/config/schema';

describe('server config schema', () => {
  it('accepts password auth server configs', () => {
    const parsed = parseServerConfig({
      id: 'server-1',
      label: 'Production',
      group: 'prod',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.host).toBe('example.com');
  });

  it('accepts private key configs with a key path', () => {
    const parsed = serverConfigSchema.parse({
      id: 'server-2',
      label: 'Staging',
      host: 'staging.example.com',
      port: 2222,
      username: 'deploy',
      authType: 'privateKey',
      privateKeyPath: 'C:/Users/alan/.ssh/id_ed25519',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.authType).toBe('privateKey');
  });

  it('rejects agent auth and jumpHost fields', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-3',
        label: 'Bad',
        host: 'bad.example.com',
        port: 22,
        username: 'root',
        authType: 'agent',
        jumpHost: { host: 'jump.example.com' },
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('requires privateKeyPath for private key auth', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-4',
        label: 'Missing Key',
        host: 'key.example.com',
        port: 22,
        username: 'deploy',
        authType: 'privateKey',
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run failing schema tests**

Run:

```powershell
npm test -- test/config/schema.test.ts
```

Expected: FAIL because `src/config/schema.ts` does not exist.

- [ ] **Step 3: Implement schema**

Create `src/config/schema.ts`:

```ts
import { z } from 'zod';

export const serverConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    group: z.string().trim().optional(),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1),
    authType: z.enum(['password', 'privateKey']),
    privateKeyPath: z.string().min(1).optional(),
    keepAliveInterval: z.number().int().min(0),
    encoding: z.literal('utf-8'),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.authType === 'privateKey' && !value.privateKeyPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['privateKeyPath'],
        message: 'privateKeyPath is required for privateKey auth'
      });
    }
  });

export const serverConfigListSchema = z.array(serverConfigSchema);

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type AuthType = ServerConfig['authType'];

export function parseServerConfig(value: unknown): ServerConfig {
  return serverConfigSchema.parse(value);
}

export function parseServerConfigList(value: unknown): ServerConfig[] {
  return serverConfigListSchema.parse(value);
}
```

- [ ] **Step 4: Verify schema**

Run:

```powershell
npm test -- test/config/schema.test.ts
npm run typecheck
```

Expected: schema tests PASS. Typecheck may still report missing later modules; continue.

- [ ] **Step 5: Commit schema**

Run:

```powershell
git add src/config/schema.ts test/config/schema.test.ts
git commit -m "feat: add server config schema"
```

Expected: commit succeeds.

## Task 4: Implement ConfigManager

**Files:**
- Create: `src/config/ConfigManager.ts`
- Test: `test/config/ConfigManager.test.ts`

- [ ] **Step 1: Write failing ConfigManager tests**

Create `test/config/ConfigManager.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigManager, type ExtensionMemento, type SecretStore } from '../../src/config/ConfigManager';
import type { ServerConfig } from '../../src/config/schema';

class MemoryMemento implements ExtensionMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
}

class MemorySecretStore implements SecretStore {
  data = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'server-1',
    label: 'Production',
    group: 'prod',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe('ConfigManager', () => {
  it('creates and lists servers without storing passwords in config', async () => {
    const secrets = new MemorySecretStore();
    const manager = new ConfigManager(new MemoryMemento(), secrets);

    await manager.saveServer(server(), 'super-secret');

    expect(await manager.listServers()).toEqual([server()]);
    expect(await manager.getPassword('server-1')).toBe('super-secret');
  });

  it('updates existing servers by id', async () => {
    const manager = new ConfigManager(new MemoryMemento(), new MemorySecretStore());

    await manager.saveServer(server());
    await manager.saveServer(server({ label: 'Renamed', updatedAt: 2 }));

    expect((await manager.getServer('server-1'))?.label).toBe('Renamed');
  });

  it('deletes server config and password', async () => {
    const secrets = new MemorySecretStore();
    const manager = new ConfigManager(new MemoryMemento(), secrets);

    await manager.saveServer(server(), 'super-secret');
    await manager.deleteServer('server-1');

    expect(await manager.listServers()).toEqual([]);
    expect(await manager.getPassword('server-1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run failing ConfigManager tests**

Run:

```powershell
npm test -- test/config/ConfigManager.test.ts
```

Expected: FAIL because `ConfigManager.ts` does not exist.

- [ ] **Step 3: Implement ConfigManager**

Create `src/config/ConfigManager.ts`:

```ts
import { parseServerConfig, parseServerConfigList, type ServerConfig } from './schema';

const SERVERS_KEY = 'sshManager.servers';
const PASSWORD_PREFIX = 'sshManager.password.';

export interface ExtensionMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export class ConfigManager {
  constructor(
    private readonly globalState: ExtensionMemento,
    private readonly secrets: SecretStore
  ) {}

  async listServers(): Promise<ServerConfig[]> {
    return parseServerConfigList(this.globalState.get<unknown[]>(SERVERS_KEY, []));
  }

  async getServer(id: string): Promise<ServerConfig | undefined> {
    return (await this.listServers()).find((server) => server.id === id);
  }

  async saveServer(server: ServerConfig, password?: string): Promise<void> {
    const parsed = parseServerConfig(server);
    const servers = await this.listServers();
    const next = [...servers.filter((entry) => entry.id !== parsed.id), parsed].sort((a, b) =>
      a.label.localeCompare(b.label)
    );
    await this.globalState.update(SERVERS_KEY, next);
    if (password !== undefined) {
      await this.secrets.store(this.passwordKey(parsed.id), password);
    }
  }

  async deleteServer(id: string): Promise<void> {
    const servers = await this.listServers();
    await this.globalState.update(
      SERVERS_KEY,
      servers.filter((server) => server.id !== id)
    );
    await this.secrets.delete(this.passwordKey(id));
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.secrets.get(this.passwordKey(id));
  }

  passwordKey(id: string): string {
    return `${PASSWORD_PREFIX}${id}`;
  }
}
```

- [ ] **Step 4: Verify ConfigManager**

Run:

```powershell
npm test -- test/config/schema.test.ts test/config/ConfigManager.test.ts
```

Expected: both test files PASS.

- [ ] **Step 5: Commit ConfigManager**

Run:

```powershell
git add src/config/ConfigManager.ts test/config/ConfigManager.test.ts
git commit -m "feat: add server configuration manager"
```

Expected: commit succeeds.

## Task 5: Implement HostKeyStore

**Files:**
- Create: `src/ssh/HostKeyStore.ts`
- Test: `test/ssh/HostKeyStore.test.ts`

- [ ] **Step 1: Write failing HostKeyStore tests**

Create `test/ssh/HostKeyStore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HostKeyStore, type HostKeyMemento } from '../../src/ssh/HostKeyStore';

class MemoryMemento implements HostKeyMemento {
  private data = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

describe('HostKeyStore', () => {
  it('returns unknown for an unseen host', async () => {
    const store = new HostKeyStore(new MemoryMemento());
    expect(await store.check('example.com', 22, 'SHA256:abc')).toBe('unknown');
  });

  it('trusts a host and returns trusted for the same fingerprint', async () => {
    const store = new HostKeyStore(new MemoryMemento());
    await store.trust('example.com', 22, 'SHA256:abc', 'ssh-ed25519');
    expect(await store.check('example.com', 22, 'SHA256:abc')).toBe('trusted');
  });

  it('returns changed when a trusted fingerprint differs', async () => {
    const store = new HostKeyStore(new MemoryMemento());
    await store.trust('example.com', 22, 'SHA256:abc', 'ssh-ed25519');
    expect(await store.check('example.com', 22, 'SHA256:def')).toBe('changed');
  });
});
```

- [ ] **Step 2: Run failing HostKeyStore tests**

Run:

```powershell
npm test -- test/ssh/HostKeyStore.test.ts
```

Expected: FAIL because `HostKeyStore.ts` does not exist.

- [ ] **Step 3: Implement HostKeyStore**

Create `src/ssh/HostKeyStore.ts`:

```ts
const HOST_KEYS_KEY = 'sshManager.trustedHostKeys';

export type HostKeyStatus = 'unknown' | 'trusted' | 'changed';

export interface TrustedHostKey {
  host: string;
  port: number;
  fingerprint: string;
  algorithm?: string;
  trustedAt: number;
}

export interface HostKeyMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export class HostKeyStore {
  constructor(private readonly globalState: HostKeyMemento) {}

  async check(host: string, port: number, fingerprint: string): Promise<HostKeyStatus> {
    const keys = this.read();
    const existing = keys[this.key(host, port)];
    if (!existing) {
      return 'unknown';
    }
    return existing.fingerprint === fingerprint ? 'trusted' : 'changed';
  }

  async trust(host: string, port: number, fingerprint: string, algorithm?: string): Promise<void> {
    const keys = this.read();
    keys[this.key(host, port)] = {
      host,
      port,
      fingerprint,
      algorithm,
      trustedAt: Date.now()
    };
    await this.globalState.update(HOST_KEYS_KEY, keys);
  }

  getTrusted(host: string, port: number): TrustedHostKey | undefined {
    return this.read()[this.key(host, port)];
  }

  private read(): Record<string, TrustedHostKey> {
    return this.globalState.get<Record<string, TrustedHostKey>>(HOST_KEYS_KEY, {});
  }

  private key(host: string, port: number): string {
    return `${host}:${port}`;
  }
}
```

- [ ] **Step 4: Verify HostKeyStore**

Run:

```powershell
npm test -- test/ssh/HostKeyStore.test.ts
npm test
```

Expected: HostKeyStore tests PASS and all existing tests PASS.

- [ ] **Step 5: Commit HostKeyStore**

Run:

```powershell
git add src/ssh/HostKeyStore.ts test/ssh/HostKeyStore.test.ts
git commit -m "feat: add host key trust store"
```

Expected: commit succeeds.

## Task 6: Implement TreeView Grouping

**Files:**
- Create: `src/tree/TreeItems.ts`
- Create: `src/tree/ServerTreeProvider.ts`
- Test: `test/tree/ServerTreeProvider.test.ts`

- [ ] **Step 1: Write failing TreeView tests**

Create `test/tree/ServerTreeProvider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ServerTreeProvider } from '../../src/tree/ServerTreeProvider';
import { GroupTreeItem, ServerTreeItem } from '../../src/tree/TreeItems';
import type { ServerConfig } from '../../src/config/schema';

function server(id: string, label: string, group?: string): ServerConfig {
  return {
    id,
    label,
    group,
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

describe('ServerTreeProvider', () => {
  it('groups servers and puts ungrouped servers in Default', async () => {
    const provider = new ServerTreeProvider({
      listServers: async () => [server('a', 'A', 'prod'), server('b', 'B'), server('c', 'C', 'prod')]
    });

    const roots = (await provider.getChildren()) as GroupTreeItem[];
    expect(roots.map((item) => item.groupName)).toEqual(['Default', 'prod']);

    const prodChildren = (await provider.getChildren(roots[1])) as ServerTreeItem[];
    expect(prodChildren.map((item) => item.server.label)).toEqual(['A', 'C']);
  });
});
```

- [ ] **Step 2: Run failing TreeView tests**

Run:

```powershell
npm test -- test/tree/ServerTreeProvider.test.ts
```

Expected: FAIL because tree modules do not exist.

- [ ] **Step 3: Implement TreeItems and ServerTreeProvider**

Create `src/tree/TreeItems.ts`:

```ts
import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';

export class GroupTreeItem extends vscode.TreeItem {
  constructor(public readonly groupName: string) {
    super(groupName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'group';
  }
}

export class ServerTreeItem extends vscode.TreeItem {
  constructor(public readonly server: ServerConfig) {
    super(server.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'server';
    this.description = `${server.username}@${server.host}:${server.port}`;
    this.tooltip = this.description;
    this.command = {
      command: 'sshManager.connect',
      title: 'Connect',
      arguments: [this]
    };
  }
}
```

Create `src/tree/ServerTreeProvider.ts`:

```ts
import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';
import { GroupTreeItem, ServerTreeItem } from './TreeItems';

export interface ServerListSource {
  listServers(): Promise<ServerConfig[]>;
}

export class ServerTreeProvider implements vscode.TreeDataProvider<GroupTreeItem | ServerTreeItem> {
  private readonly changed = new vscode.EventEmitter<GroupTreeItem | ServerTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: ServerListSource) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: GroupTreeItem | ServerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GroupTreeItem | ServerTreeItem): Promise<Array<GroupTreeItem | ServerTreeItem>> {
    const servers = await this.source.listServers();
    if (!element) {
      return Array.from(new Set(servers.map((server) => this.groupName(server))))
        .sort((a, b) => a.localeCompare(b))
        .map((group) => new GroupTreeItem(group));
    }
    if (element instanceof GroupTreeItem) {
      return servers
        .filter((server) => this.groupName(server) === element.groupName)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((server) => new ServerTreeItem(server));
    }
    return [];
  }

  private groupName(server: ServerConfig): string {
    const group = server.group?.trim();
    return group && group.length > 0 ? group : 'Default';
  }
}
```

- [ ] **Step 4: Verify TreeView grouping**

Run:

```powershell
npm test -- test/tree/ServerTreeProvider.test.ts
npm test
```

Expected: all tests PASS.

- [ ] **Step 5: Commit TreeView**

Run:

```powershell
git add src/tree test/tree/ServerTreeProvider.test.ts
git commit -m "feat: add grouped server tree provider"
```

Expected: commit succeeds.

## Task 7: Implement Webview HTML Helpers

**Files:**
- Create: `src/webview/html.ts`
- Create: `webview/server-form/index.ts`
- Create: `webview/server-form/index.css`
- Create: `webview/terminal/index.ts`
- Create: `webview/terminal/index.css`

- [ ] **Step 1: Create HTML helper**

Create `src/webview/html.ts`:

```ts
import * as vscode from 'vscode';
import { createNonce } from '../utils/nonce';

export interface WebviewAsset {
  script: vscode.Uri;
  style?: vscode.Uri;
}

export function renderWebviewHtml(webview: vscode.Webview, asset: WebviewAsset, body: string): string {
  const nonce = createNonce();
  const styleTag = asset.style
    ? `<link rel="stylesheet" href="${webview.asWebviewUri(asset.style)}">`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource}; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${styleTag}
</head>
<body>
  ${body}
  <script nonce="${nonce}" src="${webview.asWebviewUri(asset.script)}"></script>
</body>
</html>`;
}
```

- [ ] **Step 2: Create server form browser files**

Create `webview/server-form/index.ts`:

```ts
type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const form = document.querySelector<HTMLFormElement>('#server-form');
const authType = document.querySelector<HTMLSelectElement>('#authType');
const privateKeyPath = document.querySelector<HTMLInputElement>('#privateKeyPath');
const password = document.querySelector<HTMLInputElement>('#password');
const error = document.querySelector<HTMLElement>('#form-error');

function updateAuthFields(): void {
  const isPrivateKey = authType?.value === 'privateKey';
  privateKeyPath?.toggleAttribute('required', Boolean(isPrivateKey));
  password?.toggleAttribute('required', !isPrivateKey);
}

authType?.addEventListener('change', updateAuthFields);
updateAuthFields();

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const payload = Object.fromEntries(data.entries());
  if (!payload.label || !payload.host || !payload.username) {
    if (error) {
      error.textContent = 'Label, host, and username are required.';
    }
    return;
  }
  vscode.postMessage({ type: 'submit', payload });
});
```

Create `webview/server-form/index.css`:

```css
body {
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family);
  padding: 20px;
}

form {
  display: grid;
  gap: 12px;
  max-width: 560px;
}

label {
  display: grid;
  gap: 4px;
}

input,
select,
button {
  font: inherit;
}

#form-error {
  color: var(--vscode-errorForeground);
}
```

- [ ] **Step 3: Create terminal browser files**

Create `webview/terminal/index.ts`:

```ts
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const container = document.querySelector<HTMLElement>('#terminal');
const status = document.querySelector<HTMLElement>('#status');

if (!container) {
  throw new Error('Missing terminal container');
}

const term = new Terminal({
  cursorBlink: true,
  scrollback: Number(container.dataset.scrollback ?? '5000'),
  fontSize: Number(container.dataset.fontSize ?? '14'),
  fontFamily: container.dataset.fontFamily || 'Cascadia Code, Menlo, monospace',
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4'
  }
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());
term.open(container);
fitAddon.fit();

term.onData((data) => {
  vscode.postMessage({ type: 'input', payload: data });
});

const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  vscode.postMessage({ type: 'resize', rows: term.rows, cols: term.cols });
});
resizeObserver.observe(container);

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; payload?: unknown };
  if (message.type === 'output' && typeof message.payload === 'string') {
    term.write(message.payload);
  }
  if (message.type === 'status' && typeof message.payload === 'string' && status) {
    status.textContent = message.payload;
  }
});

vscode.postMessage({ type: 'ready', rows: term.rows, cols: term.cols });
```

Create `webview/terminal/index.css`:

```css
html,
body {
  width: 100%;
  height: 100%;
  padding: 0;
  margin: 0;
  overflow: hidden;
}

body {
  display: grid;
  grid-template-rows: auto 1fr;
  background: #1e1e1e;
}

#status {
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-sideBar-background);
  font: 12px var(--vscode-font-family);
  padding: 4px 8px;
}

#terminal {
  min-height: 0;
}
```

- [ ] **Step 4: Verify Webview bundles**

Run:

```powershell
npm run build
npm run typecheck
```

Expected: build may fail until `src/extension.ts` exists. Browser TypeScript should report no errors from the files created in this task.

- [ ] **Step 5: Commit Webview assets**

Run:

```powershell
git add src/webview/html.ts webview
git commit -m "feat: add webview browser assets"
```

Expected: commit succeeds.

## Task 8: Implement Server Form Panel

**Files:**
- Create: `src/webview/ServerFormPanel.ts`

- [ ] **Step 1: Implement ServerFormPanel**

Create `src/webview/ServerFormPanel.ts`:

```ts
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { parseServerConfig } from '../config/schema';
import { formatError } from '../utils/errors';
import { renderWebviewHtml } from './html';

type SubmitPayload = Record<string, unknown>;

export class ServerFormPanel {
  static open(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    onSaved: () => void,
    existing?: ServerConfig
  ): void {
    const panel = vscode.window.createWebviewPanel(
      'sshServerForm',
      existing ? `Edit SSH Server: ${existing.label}` : 'Add SSH Server',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')]
      }
    );

    panel.webview.html = renderWebviewHtml(
      panel.webview,
      {
        script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'server-form.js'),
        style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'server-form', 'index.css')
      },
      renderForm(existing)
    );

    panel.webview.onDidReceiveMessage(async (message: { type?: string; payload?: SubmitPayload }) => {
      if (message.type !== 'submit' || !message.payload) {
        return;
      }
      try {
        const now = Date.now();
        const authType = String(message.payload.authType);
        const server = parseServerConfig({
          id: existing?.id ?? randomUUID(),
          label: String(message.payload.label ?? '').trim(),
          group: optionalString(message.payload.group),
          host: String(message.payload.host ?? '').trim(),
          port: Number(message.payload.port ?? 22),
          username: String(message.payload.username ?? '').trim(),
          authType,
          privateKeyPath: optionalString(message.payload.privateKeyPath),
          keepAliveInterval: Number(message.payload.keepAliveInterval ?? 30),
          encoding: 'utf-8',
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        });
        const password = authType === 'password' ? optionalString(message.payload.password) : undefined;
        await configManager.saveServer(server, password);
        onSaved();
        panel.dispose();
      } catch (error) {
        void vscode.window.showErrorMessage(formatError(error));
      }
    });
  }
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : undefined;
}

function renderForm(server?: ServerConfig): string {
  const authType = server?.authType ?? 'password';
  return `<form id="server-form">
  <label>Label <input name="label" value="${escapeAttr(server?.label ?? '')}" required></label>
  <label>Group <input name="group" value="${escapeAttr(server?.group ?? '')}"></label>
  <label>Host <input name="host" value="${escapeAttr(server?.host ?? '')}" required></label>
  <label>Port <input name="port" type="number" min="1" max="65535" value="${server?.port ?? 22}" required></label>
  <label>Username <input name="username" value="${escapeAttr(server?.username ?? '')}" required></label>
  <label>Authentication
    <select id="authType" name="authType">
      <option value="password"${authType === 'password' ? ' selected' : ''}>Password</option>
      <option value="privateKey"${authType === 'privateKey' ? ' selected' : ''}>Private Key</option>
    </select>
  </label>
  <label>Password <input id="password" name="password" type="password"></label>
  <label>Private Key Path <input id="privateKeyPath" name="privateKeyPath" value="${escapeAttr(server?.privateKeyPath ?? '')}"></label>
  <label>Keepalive Interval <input name="keepAliveInterval" type="number" min="0" value="${server?.keepAliveInterval ?? 30}" required></label>
  <div id="form-error"></div>
  <button type="submit">${server ? 'Save Server' : 'Add Server'}</button>
</form>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
```

- [ ] **Step 2: Verify ServerFormPanel**

Run:

```powershell
npm run typecheck
```

Expected: typecheck may still fail until remaining modules exist, but there must be no errors in `ServerFormPanel.ts`.

- [ ] **Step 3: Commit ServerFormPanel**

Run:

```powershell
git add src/webview/ServerFormPanel.ts
git commit -m "feat: add server form panel"
```

Expected: commit succeeds.

## Task 9: Implement SshSession

**Files:**
- Create: `src/ssh/SshSession.ts`

- [ ] **Step 1: Implement SshSession**

Create `src/ssh/SshSession.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';

export interface SshSessionEvents {
  output(data: string): void;
  status(message: string): void;
  error(error: unknown): void;
}

export class SshSession {
  private client: Client | undefined;
  private shell: ClientChannel | undefined;

  constructor(
    private readonly server: ServerConfig,
    private readonly configManager: ConfigManager,
    private readonly events: SshSessionEvents
  ) {}

  async connect(): Promise<void> {
    this.events.status(`Connecting to ${this.server.host}:${this.server.port}...`);
    const config = await this.buildConnectConfig();
    const client = new Client();
    this.client = client;

    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect(config);
    });

    this.shell = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term: 'xterm-256color' }, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      });
    });

    this.shell.on('data', (data: Buffer) => {
      this.events.output(data.toString(this.server.encoding));
    });
    this.shell.on('close', () => {
      this.events.status('Disconnected');
    });
    this.events.status('Connected');
  }

  async reconnect(): Promise<void> {
    this.dispose();
    await this.connect();
  }

  write(data: string): void {
    this.shell?.write(data);
  }

  resize(rows: number, cols: number): void {
    if (rows > 0 && cols > 0) {
      this.shell?.setWindow(rows, cols, 0, 0);
    }
  }

  dispose(): void {
    this.shell?.end();
    this.client?.end();
    this.shell = undefined;
    this.client = undefined;
  }

  private async buildConnectConfig(): Promise<ConnectConfig> {
    const base: ConnectConfig = {
      host: this.server.host,
      port: this.server.port,
      username: this.server.username,
      keepaliveInterval: this.server.keepAliveInterval * 1000
    };

    if (this.server.authType === 'password') {
      const password = await this.configManager.getPassword(this.server.id);
      if (!password) {
        throw new Error('Missing password. Edit the server configuration and enter a password.');
      }
      return { ...base, password };
    }

    if (!this.server.privateKeyPath) {
      throw new Error('Missing private key path.');
    }
    return {
      ...base,
      privateKey: await readFile(this.server.privateKeyPath, 'utf8')
    };
  }
}
```

- [ ] **Step 2: Verify SshSession compiles**

Run:

```powershell
npm run typecheck
```

Expected: no type errors from `SshSession.ts`.

- [ ] **Step 3: Commit SshSession**

Run:

```powershell
git add src/ssh/SshSession.ts
git commit -m "feat: add per-tab ssh session"
```

Expected: commit succeeds.

## Task 10: Implement TerminalPanel

**Files:**
- Create: `src/webview/TerminalPanel.ts`

- [ ] **Step 1: Implement TerminalPanel**

Create `src/webview/TerminalPanel.ts`:

```ts
import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { SshSession } from '../ssh/SshSession';
import { formatError } from '../utils/errors';
import { renderWebviewHtml } from './html';

type TerminalMessage =
  | { type: 'ready'; rows: number; cols: number }
  | { type: 'input'; payload: string }
  | { type: 'resize'; rows: number; cols: number };

export class TerminalPanel {
  private session: SshSession;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly server: ServerConfig,
    private readonly configManager: ConfigManager
  ) {
    this.session = this.createSession();
  }

  static open(context: vscode.ExtensionContext, server: ServerConfig, configManager: ConfigManager): TerminalPanel {
    const panel = vscode.window.createWebviewPanel(
      'sshTerminal',
      `SSH: ${server.label}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')]
      }
    );

    const terminal = new TerminalPanel(panel, server, configManager);
    panel.webview.html = renderWebviewHtml(
      panel.webview,
      {
        script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'terminal.js'),
        style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'terminal', 'index.css')
      },
      `<div id="status">Starting...</div><div id="terminal" data-scrollback="5000" data-font-size="14" data-font-family="Cascadia Code, Menlo, monospace"></div>`
    );
    terminal.bind();
    void terminal.connect();
    return terminal;
  }

  async connect(): Promise<void> {
    try {
      await this.session.connect();
    } catch (error) {
      this.postStatus(formatError(error));
    }
  }

  async reconnect(): Promise<void> {
    try {
      this.postStatus('Reconnecting...');
      await this.session.reconnect();
    } catch (error) {
      this.postStatus(formatError(error));
    }
  }

  disconnect(): void {
    this.session.dispose();
    this.postStatus('Disconnected');
  }

  private bind(): void {
    this.panel.webview.onDidReceiveMessage((message: TerminalMessage) => {
      if (message.type === 'input' && typeof message.payload === 'string') {
        this.session.write(message.payload);
      }
      if (message.type === 'resize') {
        this.session.resize(message.rows, message.cols);
      }
    });

    this.panel.onDidDispose(() => {
      this.session.dispose();
    });
  }

  private createSession(): SshSession {
    return new SshSession(this.server, this.configManager, {
      output: (data) => {
        void this.panel.webview.postMessage({ type: 'output', payload: data });
      },
      status: (message) => this.postStatus(message),
      error: (error) => this.postStatus(formatError(error))
    });
  }

  private postStatus(message: string): void {
    void this.panel.webview.postMessage({ type: 'status', payload: message });
  }
}
```

- [ ] **Step 2: Verify TerminalPanel compiles**

Run:

```powershell
npm run typecheck
```

Expected: no type errors from `TerminalPanel.ts`.

- [ ] **Step 3: Commit TerminalPanel**

Run:

```powershell
git add src/webview/TerminalPanel.ts
git commit -m "feat: add terminal panel"
```

Expected: commit succeeds.

## Task 11: Wire Extension Commands

**Files:**
- Create: `src/extension.ts`

- [ ] **Step 1: Implement extension entry**

Create `src/extension.ts`:

```ts
import * as vscode from 'vscode';
import { ConfigManager } from './config/ConfigManager';
import { ServerTreeProvider } from './tree/ServerTreeProvider';
import { ServerTreeItem } from './tree/TreeItems';
import { ServerFormPanel } from './webview/ServerFormPanel';
import { TerminalPanel } from './webview/TerminalPanel';

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigManager(context.globalState, context.secrets);
  const treeProvider = new ServerTreeProvider(configManager);
  const terminals = new Set<TerminalPanel>();

  context.subscriptions.push(
    vscode.window.createTreeView('sshManager.servers', {
      treeDataProvider: treeProvider,
      showCollapseAll: true
    }),
    vscode.commands.registerCommand('sshManager.addServer', () => {
      ServerFormPanel.open(context, configManager, () => treeProvider.refresh());
    }),
    vscode.commands.registerCommand('sshManager.editServer', async (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      const server = await configManager.getServer(item.server.id);
      if (server) {
        ServerFormPanel.open(context, configManager, () => treeProvider.refresh(), server);
      }
    }),
    vscode.commands.registerCommand('sshManager.deleteServer', async (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Delete SSH server "${item.server.label}"?`,
        { modal: true },
        'Delete'
      );
      if (answer === 'Delete') {
        await configManager.deleteServer(item.server.id);
        treeProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('sshManager.connect', (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      terminals.add(TerminalPanel.open(context, item.server, configManager));
    }),
    vscode.commands.registerCommand('sshManager.copyHost', async (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      await vscode.env.clipboard.writeText(`${item.server.username}@${item.server.host}:${item.server.port}`);
    }),
    vscode.commands.registerCommand('sshManager.refresh', () => {
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('sshManager.disconnect', () => {
      for (const terminal of terminals) {
        terminal.disconnect();
      }
    }),
    vscode.commands.registerCommand('sshManager.reconnect', async () => {
      for (const terminal of terminals) {
        await terminal.reconnect();
      }
    })
  );
}

export function deactivate(): void {}
```

- [ ] **Step 2: Verify full build**

Run:

```powershell
npm run typecheck
npm run build
npm test
```

Expected: typecheck, build, and tests PASS. If `vscode.env.clipboard` is missing from the test fixture, add this to `test-fixtures/vscode.ts`:

```ts
export const env = {
  clipboard: {
    writeText: async (_value: string) => undefined
  }
};
```

- [ ] **Step 3: Commit command wiring**

Run:

```powershell
git add src/extension.ts test-fixtures/vscode.ts
git commit -m "feat: wire extension commands"
```

Expected: commit succeeds.

## Task 12: Add Host Fingerprint Flow

**Files:**
- Modify: `src/ssh/SshSession.ts`
- Modify: `src/webview/TerminalPanel.ts`
- Modify: `src/extension.ts`

- [ ] **Step 1: Extend SshSession options for host key checks**

Modify the `SshSession` constructor to accept `hostVerifier` and `hostHash` through `ConnectConfig`. Add this interface near `SshSessionEvents`:

```ts
export interface HostKeyVerifier {
  verify(host: string, port: number, hashedKey: string): Promise<boolean>;
}
```

Update the constructor signature:

```ts
constructor(
  private readonly server: ServerConfig,
  private readonly configManager: ConfigManager,
  private readonly events: SshSessionEvents,
  private readonly hostKeyVerifier?: HostKeyVerifier
) {}
```

In `buildConnectConfig`, include:

```ts
hostHash: 'sha256',
hostVerifier: this.hostKeyVerifier
  ? (hashedKey: string, callback: (valid: boolean) => void) => {
      void this.hostKeyVerifier
        ?.verify(this.server.host, this.server.port, hashedKey)
        .then(callback, () => callback(false));
    }
  : undefined
```

- [ ] **Step 2: Pass HostKeyStore through TerminalPanel**

Modify `TerminalPanel.open` to accept a verifier:

```ts
static open(
  context: vscode.ExtensionContext,
  server: ServerConfig,
  configManager: ConfigManager,
  hostKeyVerifier?: HostKeyVerifier
): TerminalPanel
```

Store the verifier in the class and pass it to `new SshSession(...)`.

- [ ] **Step 3: Wire HostKeyStore in `extension.ts`**

Import and create the store:

```ts
import { HostKeyStore } from './ssh/HostKeyStore';

const hostKeyStore = new HostKeyStore(context.globalState);
```

Create verifier before registering commands:

```ts
const hostKeyVerifier = {
  async verify(host: string, port: number, fingerprint: string): Promise<boolean> {
    const status = await hostKeyStore.check(host, port, fingerprint);
    if (status === 'trusted') {
      return true;
    }
    if (status === 'changed') {
      await vscode.window.showErrorMessage(
        `Host key for ${host}:${port} changed. Connection blocked. Fingerprint: ${fingerprint}`
      );
      return false;
    }
    const answer = await vscode.window.showWarningMessage(
      `Trust SSH host ${host}:${port}? Fingerprint: ${fingerprint}`,
      { modal: true },
      'Trust and Connect'
    );
    if (answer === 'Trust and Connect') {
      await hostKeyStore.trust(host, port, fingerprint);
      return true;
    }
    return false;
  }
};
```

Pass it to `TerminalPanel.open(context, item.server, configManager, hostKeyVerifier)`.

- [ ] **Step 4: Verify host key flow compiles and tests pass**

Run:

```powershell
npm run typecheck
npm run build
npm test
```

Expected: all commands PASS.

- [ ] **Step 5: Commit host key flow**

Run:

```powershell
git add src/ssh/SshSession.ts src/webview/TerminalPanel.ts src/extension.ts
git commit -m "feat: add host fingerprint trust flow"
```

Expected: commit succeeds.

## Task 13: Add Manual Test Environment Notes

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document local run and SSH test setup**

Append this to `README.md`:

~~~md
## Development

Install dependencies:

```powershell
npm install
```

Build and test:

```powershell
npm run typecheck
npm run build
npm test
```

Run the extension:

1. Open this folder in VS Code.
2. Run `npm run build`.
3. Press F5 to launch an Extension Development Host.
4. Open the SSH activity bar view.
5. Add a server with password or private key authentication.
6. Connect to open an independent terminal tab.

## Manual SSH Test Container

Use any local SSH server or a disposable container. The MVP must be manually checked for:

- Password login.
- Private key login.
- Terminal input and output.
- Window resize.
- Disconnect.
- Manual reconnect.
- Unknown host trust prompt.
- Changed host key blocking.
~~~

- [ ] **Step 2: Verify README and project**

Run:

```powershell
npm run typecheck
npm run build
npm test
```

Expected: all commands PASS.

- [ ] **Step 3: Commit docs**

Run:

```powershell
git add README.md
git commit -m "docs: add development and manual test notes"
```

Expected: commit succeeds.

## Task 14: Final Verification

**Files:**
- No file changes unless verification exposes a defect.

- [ ] **Step 1: Run full local verification**

Run:

```powershell
npm run typecheck
npm run build
npm test
```

Expected:

- `npm run typecheck`: PASS.
- `npm run build`: PASS and creates `dist/extension.js`, `dist/webview/terminal.js`, and `dist/webview/server-form.js`.
- `npm test`: PASS.

- [ ] **Step 2: Inspect git status**

Run:

```powershell
git status --short
```

Expected: no uncommitted changes.

- [ ] **Step 3: Record MVP gaps for post-MVP backlog**

Confirm these are absent from commands, schema, and README MVP scope:

- SSH config import.
- SSH agent authentication.
- Jump host support.
- Automatic reconnect.
- Quick commands.
- SFTP browser.
- Port forwarding UI.
- Shared connection pool.

- [ ] **Step 4: Tag implementation completion**

Run:

```powershell
git tag mvp-plan-complete
```

Expected: tag created locally.

## Self-Review Notes

Spec coverage:

- Server CRUD: Tasks 4, 8, 11.
- Webview form: Tasks 7, 8.
- Lightweight grouping: Task 6.
- Password and private key direct SSH: Tasks 3, 4, 9.
- One tab per connect with independent SSH client: Tasks 9, 10, 11.
- xterm.js terminal bridge: Tasks 7, 10.
- Disconnect and manual reconnect: Tasks 9, 10, 11.
- Host fingerprint trust flow: Tasks 5, 12.
- Security redaction and storage boundaries: Tasks 2, 4, 5, 12.
- Build, test, and documentation: Tasks 1, 13, 14.

Scope check:

- The plan implements one cohesive MVP. Deferred features remain absent from the model, command list, and implementation tasks.

Type consistency:

- `ServerConfig`, `ConfigManager`, `HostKeyStore`, `SshSession`, `ServerTreeProvider`, `ServerFormPanel`, and `TerminalPanel` names are consistent across tasks.
