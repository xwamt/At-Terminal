# Asset Import and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build encrypted AT Terminal asset export/import so users can migrate SSH server configuration, optional passwords, and optional private keys between devices and IDE variants.

**Architecture:** Add a focused `src/assets` subsystem for package schema, crypto, export, import, and VS Code command orchestration. Keep `extension.ts` as wiring only, keep `ConfigManager` as the persistence boundary, and expose the same commands in base and MCP manifests.

**Tech Stack:** TypeScript, VS Code Extension API, Node `crypto`, Node `fs/promises`, Zod, Vitest.

---

## File Structure

- Create `src/assets/AssetPackage.ts`: versioned package wrapper/payload schemas, types, and validation helpers.
- Create `src/assets/AssetCrypto.ts`: password-based encryption/decryption using `scrypt` and `aes-256-gcm`.
- Create `src/assets/AssetExportService.ts`: gather servers, optional passwords, optional private key file contents, and package omissions.
- Create `src/assets/AssetImportService.ts`: conflict detection, id remapping, private key writes, password storage, and import summaries.
- Create `src/assets/AssetCommands.ts`: VS Code prompts, save/open dialogs, progress, warning summaries, and command handlers.
- Modify `src/extension.ts`: register import/export commands and refresh the Servers tree after import.
- Modify `package.json`, `package.base.json`, `package.mcp.json`: contribute import/export commands and Servers view title actions.
- Create tests under `test/assets/`.
- Modify `test/package.variants.test.ts`: assert both variants expose commands and menus.
- Modify `test-fixtures/vscode.ts`: add dialog stubs only if command tests need them.

## Task 1: Asset Package Schema

**Files:**
- Create: `src/assets/AssetPackage.ts`
- Test: `test/assets/AssetPackage.test.ts`

- [ ] **Step 1: Write failing package schema tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  ASSET_PACKAGE_FORMAT,
  ASSET_PACKAGE_VERSION,
  parseAssetPackageEnvelope,
  parseAssetPackagePayload
} from '../../src/assets/AssetPackage';

describe('AssetPackage', () => {
  it('parses a valid encrypted package envelope', () => {
    expect(
      parseAssetPackageEnvelope({
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        kdf: 'scrypt',
        cipher: 'aes-256-gcm',
        salt: 'c2FsdA==',
        iv: 'aXY=',
        authTag: 'dGFn',
        ciphertext: 'Y2lwaGVydGV4dA=='
      })
    ).toEqual(
      expect.objectContaining({
        format: 'at-terminal-assets',
        version: 1,
        kdf: 'scrypt',
        cipher: 'aes-256-gcm'
      })
    );
  });

  it('parses a valid decrypted payload', () => {
    expect(
      parseAssetPackagePayload({
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        createdAt: 1,
        source: { extensionName: 'at-terminal', extensionVersion: '2.10.1' },
        options: { includesPasswords: true, includesPrivateKeys: true, includesHostTrust: false },
        servers: [
          {
            id: 'server-1',
            label: 'Prod',
            host: 'example.com',
            port: 22,
            username: 'deploy',
            authType: 'password',
            keepAliveInterval: 30,
            encoding: 'utf-8',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        passwords: { 'server-1': 'secret' },
        privateKeys: [],
        omissions: []
      }).servers
    ).toHaveLength(1);
  });

  it('rejects host trust exports in v1 payloads', () => {
    expect(() =>
      parseAssetPackagePayload({
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        createdAt: 1,
        source: { extensionName: 'at-terminal', extensionVersion: '2.10.1' },
        options: { includesPasswords: false, includesPrivateKeys: false, includesHostTrust: true },
        servers: [],
        passwords: {},
        privateKeys: [],
        omissions: []
      })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run package schema test to verify it fails**

Run: `npx vitest run test/assets/AssetPackage.test.ts`

Expected: FAIL because `src/assets/AssetPackage.ts` does not exist.

- [ ] **Step 3: Implement package schema**

Create `src/assets/AssetPackage.ts`:

```ts
import { z } from 'zod';
import { serverConfigSchema } from '../config/schema';

export const ASSET_PACKAGE_FORMAT = 'at-terminal-assets';
export const ASSET_PACKAGE_VERSION = 1;
export const ASSET_PACKAGE_EXTENSION = '.at-terminal-assets';

const base64Schema = z.string().min(1);

export const assetPackageEnvelopeSchema = z
  .object({
    format: z.literal(ASSET_PACKAGE_FORMAT),
    version: z.literal(ASSET_PACKAGE_VERSION),
    kdf: z.literal('scrypt'),
    cipher: z.literal('aes-256-gcm'),
    salt: base64Schema,
    iv: base64Schema,
    authTag: base64Schema,
    ciphertext: base64Schema
  })
  .strict();

export const assetPackagePayloadSchema = z
  .object({
    format: z.literal(ASSET_PACKAGE_FORMAT),
    version: z.literal(ASSET_PACKAGE_VERSION),
    createdAt: z.number().int().nonnegative(),
    source: z
      .object({
        extensionName: z.string().min(1),
        extensionVersion: z.string().min(1)
      })
      .strict(),
    options: z
      .object({
        includesPasswords: z.boolean(),
        includesPrivateKeys: z.boolean(),
        includesHostTrust: z.literal(false)
      })
      .strict(),
    servers: z.array(serverConfigSchema),
    passwords: z.record(z.string().min(1), z.string()),
    privateKeys: z.array(
      z
        .object({
          serverId: z.string().min(1),
          originalBasename: z.string().min(1),
          contentBase64: base64Schema
        })
        .strict()
    ),
    omissions: z.array(
      z
        .object({
          serverId: z.string().min(1),
          kind: z.enum(['password', 'privateKey']),
          reason: z.string().min(1)
        })
        .strict()
    )
  })
  .strict();

export type AssetPackageEnvelope = z.infer<typeof assetPackageEnvelopeSchema>;
export type AssetPackagePayload = z.infer<typeof assetPackagePayloadSchema>;
export type AssetPackageOmission = AssetPackagePayload['omissions'][number];
export type AssetPrivateKeyRecord = AssetPackagePayload['privateKeys'][number];

export function parseAssetPackageEnvelope(value: unknown): AssetPackageEnvelope {
  return assetPackageEnvelopeSchema.parse(value);
}

export function parseAssetPackagePayload(value: unknown): AssetPackagePayload {
  return assetPackagePayloadSchema.parse(value);
}
```

- [ ] **Step 4: Run package schema test to verify it passes**

Run: `npx vitest run test/assets/AssetPackage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/assets/AssetPackage.ts test/assets/AssetPackage.test.ts
git commit -m "feat: add asset package schema"
```

## Task 2: Asset Package Encryption

**Files:**
- Create: `src/assets/AssetCrypto.ts`
- Test: `test/assets/AssetCrypto.test.ts`

- [ ] **Step 1: Write failing crypto tests**

```ts
import { describe, expect, it } from 'vitest';
import { decryptAssetPayload, encryptAssetPayload } from '../../src/assets/AssetCrypto';
import { ASSET_PACKAGE_FORMAT, ASSET_PACKAGE_VERSION, type AssetPackagePayload } from '../../src/assets/AssetPackage';

function payload(): AssetPackagePayload {
  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    createdAt: 1,
    source: { extensionName: 'at-terminal', extensionVersion: '2.10.1' },
    options: { includesPasswords: true, includesPrivateKeys: false, includesHostTrust: false },
    servers: [],
    passwords: { 'server-1': 'secret' },
    privateKeys: [],
    omissions: []
  };
}

describe('AssetCrypto', () => {
  it('round trips encrypted payloads', async () => {
    const envelope = await encryptAssetPayload(payload(), 'package-pass');

    expect(envelope.ciphertext).not.toContain('secret');
    await expect(decryptAssetPayload(envelope, 'package-pass')).resolves.toEqual(payload());
  });

  it('rejects wrong package passwords', async () => {
    const envelope = await encryptAssetPayload(payload(), 'package-pass');

    await expect(decryptAssetPayload(envelope, 'wrong-pass')).rejects.toThrow('Invalid package password or corrupted asset package.');
  });
});
```

- [ ] **Step 2: Run crypto test to verify it fails**

Run: `npx vitest run test/assets/AssetCrypto.test.ts`

Expected: FAIL because `src/assets/AssetCrypto.ts` does not exist.

- [ ] **Step 3: Implement encryption helpers**

Create `src/assets/AssetCrypto.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import {
  ASSET_PACKAGE_FORMAT,
  ASSET_PACKAGE_VERSION,
  parseAssetPackageEnvelope,
  parseAssetPackagePayload,
  type AssetPackageEnvelope,
  type AssetPackagePayload
} from './AssetPackage';

const scrypt = promisify(scryptCallback);
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export async function encryptAssetPayload(
  payload: AssetPackagePayload,
  packagePassword: string
): Promise<AssetPackageEnvelope> {
  const parsed = parseAssetPackagePayload(payload);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = (await scrypt(packagePassword, salt, KEY_BYTES)) as Buffer;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

export async function decryptAssetPayload(
  envelope: AssetPackageEnvelope,
  packagePassword: string
): Promise<AssetPackagePayload> {
  const parsedEnvelope = parseAssetPackageEnvelope(envelope);
  try {
    const salt = Buffer.from(parsedEnvelope.salt, 'base64');
    const iv = Buffer.from(parsedEnvelope.iv, 'base64');
    const authTag = Buffer.from(parsedEnvelope.authTag, 'base64');
    const ciphertext = Buffer.from(parsedEnvelope.ciphertext, 'base64');
    const key = (await scrypt(packagePassword, salt, KEY_BYTES)) as Buffer;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return parseAssetPackagePayload(JSON.parse(plaintext));
  } catch {
    throw new Error('Invalid package password or corrupted asset package.');
  }
}
```

- [ ] **Step 4: Run crypto tests**

Run: `npx vitest run test/assets/AssetCrypto.test.ts test/assets/AssetPackage.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/assets/AssetCrypto.ts test/assets/AssetCrypto.test.ts
git commit -m "feat: encrypt asset packages"
```

## Task 3: Asset Export Service

**Files:**
- Create: `src/assets/AssetExportService.ts`
- Test: `test/assets/AssetExportService.test.ts`

- [ ] **Step 1: Write failing export service tests**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAssetExportPayload } from '../../src/assets/AssetExportService';
import type { ServerConfig } from '../../src/config/schema';

const passwordServer: ServerConfig = {
  id: 'password-1',
  label: 'Password Server',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authType: 'password',
  keepAliveInterval: 30,
  encoding: 'utf-8',
  createdAt: 1,
  updatedAt: 1
};

describe('AssetExportService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'at-export-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports servers and selected passwords/private keys', async () => {
    const keyPath = join(dir, 'id_ed25519');
    await writeFile(keyPath, 'PRIVATE KEY');
    const keyServer: ServerConfig = { ...passwordServer, id: 'key-1', label: 'Key Server', authType: 'privateKey', privateKeyPath: keyPath };

    const payload = await createAssetExportPayload({
      servers: [passwordServer, keyServer],
      includePasswords: true,
      includePrivateKeys: true,
      extensionName: 'at-terminal',
      extensionVersion: '2.10.1',
      getPassword: async (id) => (id === 'password-1' ? 'secret' : undefined),
      now: () => 123
    });

    expect(payload.createdAt).toBe(123);
    expect(payload.passwords).toEqual({ 'password-1': 'secret' });
    expect(payload.privateKeys).toEqual([
      { serverId: 'key-1', originalBasename: 'id_ed25519', contentBase64: Buffer.from('PRIVATE KEY').toString('base64') }
    ]);
    expect(payload.omissions).toEqual([]);
  });

  it('records omissions without inserting empty secret values', async () => {
    const payload = await createAssetExportPayload({
      servers: [passwordServer, { ...passwordServer, id: 'key-1', authType: 'privateKey', privateKeyPath: join(dir, 'missing.pem') }],
      includePasswords: true,
      includePrivateKeys: true,
      extensionName: 'at-terminal',
      extensionVersion: '2.10.1',
      getPassword: async () => undefined,
      now: () => 123
    });

    expect(payload.passwords).toEqual({});
    expect(payload.privateKeys).toEqual([]);
    expect(payload.omissions).toEqual([
      { serverId: 'password-1', kind: 'password', reason: 'Password was not available in SecretStorage.' },
      { serverId: 'key-1', kind: 'privateKey', reason: 'Private key file could not be read.' }
    ]);
  });
});
```

- [ ] **Step 2: Run export test to verify it fails**

Run: `npx vitest run test/assets/AssetExportService.test.ts`

Expected: FAIL because `createAssetExportPayload` does not exist.

- [ ] **Step 3: Implement export service**

Create `src/assets/AssetExportService.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ASSET_PACKAGE_FORMAT, ASSET_PACKAGE_VERSION, type AssetPackagePayload } from './AssetPackage';
import type { ServerConfig } from '../config/schema';

export interface AssetExportOptions {
  servers: ServerConfig[];
  includePasswords: boolean;
  includePrivateKeys: boolean;
  extensionName: string;
  extensionVersion: string;
  getPassword(id: string): Promise<string | undefined>;
  now?: () => number;
}

export async function createAssetExportPayload(options: AssetExportOptions): Promise<AssetPackagePayload> {
  const passwords: Record<string, string> = {};
  const privateKeys: AssetPackagePayload['privateKeys'] = [];
  const omissions: AssetPackagePayload['omissions'] = [];

  for (const server of options.servers) {
    if (options.includePasswords && server.authType === 'password') {
      const password = await options.getPassword(server.id);
      if (password) {
        passwords[server.id] = password;
      } else {
        omissions.push({ serverId: server.id, kind: 'password', reason: 'Password was not available in SecretStorage.' });
      }
    }

    if (options.includePrivateKeys && server.authType === 'privateKey' && server.privateKeyPath) {
      try {
        const content = await readFile(server.privateKeyPath);
        privateKeys.push({
          serverId: server.id,
          originalBasename: basename(server.privateKeyPath),
          contentBase64: content.toString('base64')
        });
      } catch {
        omissions.push({ serverId: server.id, kind: 'privateKey', reason: 'Private key file could not be read.' });
      }
    }
  }

  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    createdAt: options.now?.() ?? Date.now(),
    source: { extensionName: options.extensionName, extensionVersion: options.extensionVersion },
    options: {
      includesPasswords: options.includePasswords,
      includesPrivateKeys: options.includePrivateKeys,
      includesHostTrust: false
    },
    servers: options.servers,
    passwords,
    privateKeys,
    omissions
  };
}
```

- [ ] **Step 4: Run export tests**

Run: `npx vitest run test/assets/AssetExportService.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/assets/AssetExportService.ts test/assets/AssetExportService.test.ts
git commit -m "feat: build asset export payloads"
```

## Task 4: Asset Import Service

**Files:**
- Create: `src/assets/AssetImportService.ts`
- Test: `test/assets/AssetImportService.test.ts`

- [ ] **Step 1: Write failing import service tests**

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAssetImport, type ImportedServerStore } from '../../src/assets/AssetImportService';
import { ASSET_PACKAGE_FORMAT, ASSET_PACKAGE_VERSION, type AssetPackagePayload } from '../../src/assets/AssetPackage';
import type { ServerConfig } from '../../src/config/schema';

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'server-1',
    label: 'Prod',
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

function payload(servers: ServerConfig[]): AssetPackagePayload {
  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    createdAt: 1,
    source: { extensionName: 'at-terminal', extensionVersion: '2.10.1' },
    options: { includesPasswords: true, includesPrivateKeys: true, includesHostTrust: false },
    servers,
    passwords: { 'server-1': 'secret' },
    privateKeys: [{ serverId: 'key-1', originalBasename: 'id_ed25519', contentBase64: Buffer.from('PRIVATE KEY').toString('base64') }],
    omissions: []
  };
}

class MemoryStore implements ImportedServerStore {
  saved: Array<{ server: ServerConfig; password?: string }> = [];
  constructor(public existing: ServerConfig[]) {}
  async listServers(): Promise<ServerConfig[]> {
    return this.existing;
  }
  async saveServer(server: ServerConfig, password?: string): Promise<void> {
    this.saved.push({ server, password });
  }
}

describe('AssetImportService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'at-import-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips conflicting servers and does not import their passwords', async () => {
    const store = new MemoryStore([server()]);
    const summary = await applyAssetImport({
      payload: payload([server()]),
      conflictStrategy: 'skip',
      privateKeyDirectory: dir,
      store,
      generateId: () => 'new-id'
    });

    expect(store.saved).toEqual([]);
    expect(summary).toEqual(expect.objectContaining({ imported: 0, skipped: 1, overwritten: 0, renamed: 0 }));
  });

  it('keeps both conflicting servers with a new id and remaps jump host references', async () => {
    const importedJump = server({ id: 'jump-1', label: 'Jump', host: 'jump.example.com' });
    const importedApp = server({ id: 'app-1', label: 'App', host: 'app.example.com', jumpHostId: 'jump-1' });
    const ids = ['jump-new', 'app-new'];
    const store = new MemoryStore([server({ id: 'jump-1', label: 'Jump', host: 'jump.example.com' })]);

    await applyAssetImport({
      payload: payload([importedJump, importedApp]),
      conflictStrategy: 'rename',
      privateKeyDirectory: dir,
      store,
      generateId: () => ids.shift() ?? 'fallback'
    });

    expect(store.saved.map((entry) => entry.server)).toEqual([
      expect.objectContaining({ id: 'jump-new', label: 'Jump (imported)' }),
      expect.objectContaining({ id: 'app-1', jumpHostId: 'jump-new' })
    ]);
  });

  it('writes imported private keys and rewrites privateKeyPath', async () => {
    const store = new MemoryStore([]);
    await applyAssetImport({
      payload: payload([server({ id: 'key-1', authType: 'privateKey', privateKeyPath: 'old-path' })]),
      conflictStrategy: 'skip',
      privateKeyDirectory: dir,
      store,
      generateId: () => 'new-id'
    });

    expect(store.saved[0].server.privateKeyPath).toContain('id_ed25519');
    await expect(readFile(store.saved[0].server.privateKeyPath!, 'utf8')).resolves.toBe('PRIVATE KEY');
  });
});
```

- [ ] **Step 2: Run import service test to verify it fails**

Run: `npx vitest run test/assets/AssetImportService.test.ts`

Expected: FAIL because `applyAssetImport` does not exist.

- [ ] **Step 3: Implement import service**

Create `src/assets/AssetImportService.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetPackagePayload } from './AssetPackage';
import type { ServerConfig } from '../config/schema';

export type AssetConflictStrategy = 'skip' | 'overwrite' | 'rename';

export interface ImportedServerStore {
  listServers(): Promise<ServerConfig[]>;
  saveServer(server: ServerConfig, password?: string): Promise<void>;
}

export interface AssetImportOptions {
  payload: AssetPackagePayload;
  conflictStrategy: AssetConflictStrategy;
  privateKeyDirectory: string;
  store: ImportedServerStore;
  generateId(): string;
}

export interface AssetImportSummary {
  imported: number;
  skipped: number;
  overwritten: number;
  renamed: number;
  privateKeysWritten: number;
}

export async function applyAssetImport(options: AssetImportOptions): Promise<AssetImportSummary> {
  const existing = await options.store.listServers();
  const summary: AssetImportSummary = { imported: 0, skipped: 0, overwritten: 0, renamed: 0, privateKeysWritten: 0 };
  const idMap = new Map<string, string>();
  const privateKeys = new Map(options.payload.privateKeys.map((entry) => [entry.serverId, entry]));
  const planned: Array<{ server: ServerConfig; password?: string; privateKeyContent?: Buffer; privateKeyBasename?: string }> = [];

  for (const imported of options.payload.servers) {
    const conflict = findConflict(imported, existing);
    if (conflict && options.conflictStrategy === 'skip') {
      summary.skipped += 1;
      idMap.set(imported.id, conflict.id);
      continue;
    }

    let server = { ...imported };
    if (conflict && options.conflictStrategy === 'overwrite') {
      server.id = conflict.id;
      summary.overwritten += 1;
    } else if (conflict && options.conflictStrategy === 'rename') {
      server = { ...server, id: options.generateId(), label: `${server.label} (imported)` };
      summary.renamed += 1;
    } else {
      summary.imported += 1;
    }
    idMap.set(imported.id, server.id);

    const keyRecord = privateKeys.get(imported.id);
    planned.push({
      server,
      password: options.payload.passwords[imported.id],
      privateKeyContent: keyRecord ? Buffer.from(keyRecord.contentBase64, 'base64') : undefined,
      privateKeyBasename: keyRecord?.originalBasename
    });
  }

  await mkdir(options.privateKeyDirectory, { recursive: true });

  for (const item of planned) {
    const remappedJumpHostId = item.server.jumpHostId ? idMap.get(item.server.jumpHostId) ?? item.server.jumpHostId : undefined;
    let server = { ...item.server, jumpHostId: remappedJumpHostId };
    if (item.privateKeyContent && item.privateKeyBasename) {
      const privateKeyPath = join(options.privateKeyDirectory, safePrivateKeyName(server.id, item.privateKeyBasename));
      await writeFile(privateKeyPath, item.privateKeyContent, { mode: 0o600 });
      server = { ...server, privateKeyPath };
      summary.privateKeysWritten += 1;
    }
    await options.store.saveServer(server, item.password);
  }

  return summary;
}

function findConflict(imported: ServerConfig, existing: ServerConfig[]): ServerConfig | undefined {
  return (
    existing.find((server) => server.id === imported.id) ??
    existing.find(
      (server) =>
        normalize(server.label) === normalize(imported.label) &&
        normalize(server.host) === normalize(imported.host) &&
        server.port === imported.port &&
        normalize(server.username) === normalize(imported.username)
    )
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function safePrivateKeyName(serverId: string, basename: string): string {
  const safeBase = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${serverId}-${safeBase}`;
}
```

- [ ] **Step 4: Run import tests**

Run: `npx vitest run test/assets/AssetImportService.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/assets/AssetImportService.ts test/assets/AssetImportService.test.ts
git commit -m "feat: apply asset imports"
```

## Task 5: VS Code Asset Commands

**Files:**
- Create: `src/assets/AssetCommands.ts`
- Modify: `test-fixtures/vscode.ts`
- Test: `test/assets/AssetCommands.test.ts`

- [ ] **Step 1: Write failing command tests**

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { exportAssetsCommand, importAssetsCommand } from '../../src/assets/AssetCommands';
import { encryptAssetPayload } from '../../src/assets/AssetCrypto';
import { ASSET_PACKAGE_FORMAT, ASSET_PACKAGE_VERSION } from '../../src/assets/AssetPackage';
import type { ConfigManager } from '../../src/config/ConfigManager';
import type { ServerConfig } from '../../src/config/schema';

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'Prod',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('AssetCommands', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'at-commands-'));
    (vscode.window as any).__resetDialogs();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports encrypted assets to the selected file', async () => {
    const output = join(dir, 'assets.at-terminal-assets');
    (vscode.window as any).__setSaveDialogResult(output);
    (vscode.window as any).__setQuickPickResults(['Server configuration', 'Passwords']);
    (vscode.window as any).__setInputBoxResults(['package-pass', 'package-pass']);
    const configManager = {
      listServers: async () => [server()],
      getPassword: async () => 'secret'
    } as Pick<ConfigManager, 'listServers' | 'getPassword'>;

    await exportAssetsCommand({ configManager, extensionName: 'at-terminal', extensionVersion: '2.10.1' });

    const raw = await readFile(output, 'utf8');
    expect(raw).toContain('"format"');
    expect(raw).not.toContain('secret');
  });

  it('imports assets and refreshes the server tree', async () => {
    const input = join(dir, 'assets.at-terminal-assets');
    const envelope = await encryptAssetPayload(
      {
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        createdAt: 1,
        source: { extensionName: 'at-terminal', extensionVersion: '2.10.1' },
        options: { includesPasswords: true, includesPrivateKeys: false, includesHostTrust: false },
        servers: [server()],
        passwords: { 'server-1': 'secret' },
        privateKeys: [],
        omissions: []
      },
      'package-pass'
    );
    await import('node:fs/promises').then((fs) => fs.writeFile(input, JSON.stringify(envelope), 'utf8'));
    (vscode.window as any).__setOpenDialogResult(input);
    (vscode.window as any).__setInputBoxResults(['package-pass']);
    (vscode.window as any).__setQuickPickResults(['Skip existing servers']);
    const saveServer = vi.fn();

    await importAssetsCommand({
      configManager: { listServers: async () => [], saveServer } as unknown as ConfigManager,
      privateKeyDirectory: join(dir, 'keys'),
      refreshServers: vi.fn()
    });

    expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }), 'secret');
  });
});
```

- [ ] **Step 2: Run command test to verify it fails**

Run: `npx vitest run test/assets/AssetCommands.test.ts`

Expected: FAIL because `AssetCommands.ts` and dialog test helpers do not exist.

- [ ] **Step 3: Add dialog helpers to VS Code test fixture**

Modify `test-fixtures/vscode.ts` by replacing `window` dialog functions with stateful helpers:

```ts
const dialogState = {
  openDialogResults: [] as Uri[][],
  saveDialogResults: [] as Uri[],
  inputBoxResults: [] as Array<string | undefined>,
  quickPickResults: [] as unknown[]
};

export const window = {
  __resetDialogs: () => {
    dialogState.openDialogResults = [];
    dialogState.saveDialogResults = [];
    dialogState.inputBoxResults = [];
    dialogState.quickPickResults = [];
  },
  __setOpenDialogResult: (path: string) => {
    dialogState.openDialogResults.push([Uri.file(path)]);
  },
  __setSaveDialogResult: (path: string) => {
    dialogState.saveDialogResults.push(Uri.file(path));
  },
  __setInputBoxResults: (values: Array<string | undefined>) => {
    dialogState.inputBoxResults.push(...values);
  },
  __setQuickPickResults: (values: unknown[]) => {
    dialogState.quickPickResults.push(...values);
  },
  showOpenDialog: async () => dialogState.openDialogResults.shift(),
  showSaveDialog: async () => dialogState.saveDialogResults.shift(),
  showInputBox: async () => dialogState.inputBoxResults.shift(),
  showQuickPick: async () => dialogState.quickPickResults.shift(),
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report(value: unknown): void }, token: unknown) => PromiseLike<T> | T
  ): Promise<T> =>
    task({
      report: () => undefined
    }, {}),
  createTreeView: () => ({ dispose: () => undefined }),
  createWebviewPanel: () => ({ dispose: () => undefined }),
  showTextDocument: async (document: TextDocument) => document,
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) => new StatusBarItem(),
  tabGroups: {
    onDidChangeTabs: didChangeTabs.event,
    __fireDidChangeTabs: (event: { closed: unknown[] }) => didChangeTabs.fire(event)
  }
};
```

- [ ] **Step 4: Implement command orchestration**

Create `src/assets/AssetCommands.ts`:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import { formatError } from '../utils/errors';
import { ASSET_PACKAGE_EXTENSION, parseAssetPackageEnvelope } from './AssetPackage';
import { decryptAssetPayload, encryptAssetPayload } from './AssetCrypto';
import { createAssetExportPayload } from './AssetExportService';
import { applyAssetImport, type AssetConflictStrategy } from './AssetImportService';

export interface ExportAssetsCommandOptions {
  configManager: Pick<ConfigManager, 'listServers' | 'getPassword'>;
  extensionName: string;
  extensionVersion: string;
}

export interface ImportAssetsCommandOptions {
  configManager: ConfigManager;
  privateKeyDirectory: string;
  refreshServers(): void;
}

export async function exportAssetsCommand(options: ExportAssetsCommandOptions): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`at-terminal-assets${ASSET_PACKAGE_EXTENSION}`),
    filters: { 'AT Terminal Assets': [ASSET_PACKAGE_EXTENSION.slice(1)] }
  });
  if (!target) {
    return;
  }

  const picked = await vscode.window.showQuickPick(['Server configuration', 'Passwords', 'Private key files'], {
    canPickMany: true,
    title: 'Choose assets to export'
  });
  if (!picked) {
    return;
  }

  const password = await askForConfirmedPassword('Asset package password');
  if (!password) {
    return;
  }

  try {
    const payload = await createAssetExportPayload({
      servers: await options.configManager.listServers(),
      includePasswords: picked.includes('Passwords'),
      includePrivateKeys: picked.includes('Private key files'),
      extensionName: options.extensionName,
      extensionVersion: options.extensionVersion,
      getPassword: (id) => options.configManager.getPassword(id)
    });
    const envelope = await encryptAssetPayload(payload, password);
    await writeFile(target.fsPath, JSON.stringify(envelope, null, 2), 'utf8');
    await vscode.window.showInformationMessage(`Exported ${payload.servers.length} AT Terminal server assets.`);
  } catch (error) {
    await vscode.window.showErrorMessage(formatError(error));
  }
}

export async function importAssetsCommand(options: ImportAssetsCommandOptions): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'AT Terminal Assets': [ASSET_PACKAGE_EXTENSION.slice(1)] }
  });
  const source = selected?.[0];
  if (!source) {
    return;
  }
  const password = await vscode.window.showInputBox({ prompt: 'Asset package password', password: true });
  if (!password) {
    return;
  }
  const strategyLabel = await vscode.window.showQuickPick(['Skip existing servers', 'Overwrite existing servers', 'Keep both and rename imports'], {
    title: 'Choose import conflict handling'
  });
  if (!strategyLabel) {
    return;
  }

  try {
    const envelope = parseAssetPackageEnvelope(JSON.parse(await readFile(source.fsPath, 'utf8')));
    const payload = await decryptAssetPayload(envelope, password);
    await mkdir(options.privateKeyDirectory, { recursive: true });
    const summary = await applyAssetImport({
      payload,
      conflictStrategy: conflictStrategyFromLabel(strategyLabel),
      privateKeyDirectory: options.privateKeyDirectory,
      store: options.configManager,
      generateId: randomUUID
    });
    options.refreshServers();
    await vscode.window.showInformationMessage(`Imported ${summary.imported + summary.overwritten + summary.renamed} AT Terminal server assets.`);
  } catch (error) {
    await vscode.window.showErrorMessage(formatError(error));
  }
}

export function assetPrivateKeyDirectory(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, 'imported-private-keys');
}

async function askForConfirmedPassword(prompt: string): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({ prompt, password: true });
  if (!password) {
    return undefined;
  }
  const confirmation = await vscode.window.showInputBox({ prompt: 'Confirm asset package password', password: true });
  return confirmation === password ? password : undefined;
}

function conflictStrategyFromLabel(label: string): AssetConflictStrategy {
  if (label === 'Overwrite existing servers') {
    return 'overwrite';
  }
  if (label === 'Keep both and rename imports') {
    return 'rename';
  }
  return 'skip';
}
```

- [ ] **Step 5: Run command tests**

Run: `npx vitest run test/assets/AssetCommands.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/assets/AssetCommands.ts test/assets/AssetCommands.test.ts test-fixtures/vscode.ts
git commit -m "feat: add asset import export commands"
```

## Task 6: Extension and Manifest Wiring

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `package.base.json`
- Modify: `package.mcp.json`
- Modify: `test/package.variants.test.ts`
- Test: `test/package.asset-import-export.test.ts`

- [ ] **Step 1: Write failing package contribution tests**

Create `test/package.asset-import-export.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifests = [
  JSON.parse(readFileSync('package.json', 'utf8')),
  JSON.parse(readFileSync('package.base.json', 'utf8')),
  JSON.parse(readFileSync('package.mcp.json', 'utf8'))
];

describe('asset import/export package contributions', () => {
  it('contributes asset import/export commands in all variants', () => {
    for (const manifest of manifests) {
      expect(manifest.contributes.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: 'sshManager.exportAssets', title: 'AT Terminal: Export Assets' }),
          expect.objectContaining({ command: 'sshManager.importAssets', title: 'AT Terminal: Import Assets' })
        ])
      );
    }
  });

  it('shows asset import/export actions in the Servers view title in all variants', () => {
    for (const manifest of manifests) {
      expect(manifest.contributes.menus['view/title']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: 'sshManager.exportAssets', when: 'view == sshManager.servers' }),
          expect.objectContaining({ command: 'sshManager.importAssets', when: 'view == sshManager.servers' })
        ])
      );
    }
  });
});
```

- [ ] **Step 2: Run package contribution test to verify it fails**

Run: `npx vitest run test/package.asset-import-export.test.ts`

Expected: FAIL because the commands are not contributed yet.

- [ ] **Step 3: Wire extension commands**

Modify `src/extension.ts` imports:

```ts
import { assetPrivateKeyDirectory, exportAssetsCommand, importAssetsCommand } from './assets/AssetCommands';
```

Add these disposables inside `context.subscriptions.push(...)` near other SSH server commands:

```ts
    vscode.commands.registerCommand('sshManager.exportAssets', async () => {
      await exportAssetsCommand({
        configManager,
        extensionName: context.extension.packageJSON.name,
        extensionVersion: context.extension.packageJSON.version
      });
    }),
    vscode.commands.registerCommand('sshManager.importAssets', async () => {
      await importAssetsCommand({
        configManager,
        privateKeyDirectory: assetPrivateKeyDirectory(context),
        refreshServers: () => treeProvider.refresh()
      });
    }),
```

- [ ] **Step 4: Add manifest contributions to all package manifests**

In `package.json`, `package.base.json`, and `package.mcp.json`, add to `contributes.commands`:

```json
{
  "command": "sshManager.exportAssets",
  "title": "AT Terminal: Export Assets"
},
{
  "command": "sshManager.importAssets",
  "title": "AT Terminal: Import Assets"
}
```

In each manifest's `contributes.menus["view/title"]`, add:

```json
{
  "command": "sshManager.exportAssets",
  "when": "view == sshManager.servers",
  "group": "navigation@3"
},
{
  "command": "sshManager.importAssets",
  "when": "view == sshManager.servers",
  "group": "navigation@4"
}
```

- [ ] **Step 5: Run package and extension tests**

Run: `npx vitest run test/package.asset-import-export.test.ts test/package.variants.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/extension.ts package.json package.base.json package.mcp.json test/package.asset-import-export.test.ts test/package.variants.test.ts
git commit -m "feat: wire asset import export commands"
```

## Task 7: Full Verification and Documentation Touches

**Files:**
- Modify: `README-base.md`
- Modify: `README.md`

- [ ] **Step 1: Add concise user docs**

Add a short section to both README files near SSH server management capabilities:

```md
### Asset Import and Export

Run `AT Terminal: Export Assets` to create an encrypted `.at-terminal-assets` package containing SSH server configuration. Passwords and private key files are optional export choices and are included only when selected. Run `AT Terminal: Import Assets` in another supported IDE or device to decrypt the package and import the selected assets.

Imported private keys are stored in the extension's global storage area and server configs are updated to use those new local paths. SSH host trust records are not migrated, so the first connection after import still asks for host trust confirmation.
```

- [ ] **Step 2: Run full automated verification**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

Run: `npm test`

Expected: PASS for all Vitest suites.

- [ ] **Step 3: Run package builds**

Run: `npm run build:base`

Expected: PASS and `dist/extension.js` generated.

Run: `npm run build:mcp`

Expected: PASS and `dist/mcp-server.js` generated.

- [ ] **Step 4: Inspect final diff for secret leakage**

Run: `git diff --stat`

Expected: shows only source, test, manifest, and README files related to asset import/export.

Run: `git diff | Select-String -Pattern "password|secret|privateKey|token|api_key" -CaseSensitive:$false`

Expected: matches only code identifiers, docs, and tests with fake values such as `secret`; no real credentials.

- [ ] **Step 5: Commit Task 7**

```bash
git add README.md README-base.md
git commit -m "docs: document asset import export"
```

## Final Review Checklist

- [ ] The asset package format is encrypted for every export.
- [ ] Passwords are only stored through SecretStorage on import.
- [ ] Private keys are imported under `imported-private-keys` in extension global storage.
- [ ] Host key trust is not exported or imported.
- [ ] Base and MCP manifests expose matching commands and menu items.
- [ ] `extension.ts` only wires commands; business logic lives in `src/assets`.
- [ ] `npm run typecheck`, `npm test`, `npm run build:base`, and `npm run build:mcp` pass.
