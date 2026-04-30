# Agent Context, SFTP Tools, And MCP Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only terminal context tools, first-batch non-destructive SFTP tools, and an explicit MCP configuration installer command for AT Terminal.

**Architecture:** Keep all sensitive behavior inside the VS Code extension host. Add focused core services for terminal context snapshots, agent SFTP sessions, write authorization, and MCP config installation, then expose those services through both VS Code language model tools and the existing localhost MCP bridge. The MCP stdio process remains a thin bridge client and never reads VS Code storage or secrets directly.

**Tech Stack:** TypeScript, VS Code Extension API, `ssh2` SFTP, Node `fs/path/os`, MCP TypeScript SDK, Vitest, esbuild.

---

## Scope Notes

- This plan implements the confirmed first batch only.
- SFTP tools include list/stat/read/write/create file/create directory.
- SFTP tools do not delete, rename, move, upload local files, or download to arbitrary local paths.
- SFTP write authorization is in-memory per `serverId` and cleared by extension reload.
- MCP config automation is an explicit command. First-run prompts are not implemented in this plan.

## File Structure

- Modify `src/terminal/TerminalContext.ts`
  - Own focused/default/known terminal snapshot behavior and connected-terminal lookup helpers.
- Create `src/agent/AgentToolService.ts`
  - Own shared tool behavior used by Copilot language model tools and MCP bridge endpoints.
  - Own target resolution for `serverId` and `terminalId`.
- Create `src/agent/SftpAgentService.ts`
  - Own agent-facing SFTP sessions keyed by terminal id.
  - Own read limits, UTF-8 text reads, existence checks, and write/create operations.
- Create `src/agent/SftpWriteAuthorizer.ts`
  - Own once-per-server in-memory write authorization and VS Code prompt integration.
- Create `src/mcp/McpConfigInstaller.ts`
  - Own Continue MCP config file generation/writing.
- Modify `src/agent/AgentTools.ts`
  - Register new Copilot tools and delegate to `AgentToolService`.
- Modify `src/mcp/BridgeProtocol.ts`
  - Add request/response types for context and SFTP tools.
- Modify `src/mcp/BridgeClient.ts`
  - Add methods for all new bridge endpoints.
- Modify `src/mcp/BridgeServer.ts`
  - Accept `AgentToolService`, expose new JSON endpoints, and keep token auth.
- Modify `src/mcp/server.ts`
  - Register MCP tools matching Copilot tool names and schemas.
- Modify `src/extension.ts`
  - Instantiate shared `AgentToolService`, `SftpAgentService`, `SftpWriteAuthorizer`, and `McpConfigInstaller`.
  - Register `sshManager.installMcpConfig`.
- Modify `package.json`
  - Add `languageModelTools` entries and command contribution for the config installer.
- Add tests:
  - `test/terminal/TerminalContext.test.ts`
  - `test/agent/AgentToolService.test.ts`
  - `test/agent/SftpAgentService.test.ts`
  - `test/agent/SftpWriteAuthorizer.test.ts`
  - `test/mcp/BridgeServer.test.ts`
  - `test/mcp/BridgeClient.test.ts`
  - `test/mcp/McpServerTools.test.ts`
  - `test/mcp/McpConfigInstaller.test.ts`
  - `test/package.agent-tools.test.ts`
- Modify docs:
  - `README.md`
  - `docs/superpowers/manual-tests/at-terminal-mcp.md`

## Task 1: Terminal Context Snapshot

**Files:**
- Modify: `src/terminal/TerminalContext.ts`
- Modify: `test/terminal/TerminalContext.test.ts`

- [ ] **Step 1: Write failing terminal snapshot tests**

Append these tests to `test/terminal/TerminalContext.test.ts`:

```ts
it('returns focused, default connected, connected, and known terminal summaries', () => {
  const registry = new TerminalContextRegistry();
  registry.setActive({
    terminalId: 'terminal-a',
    server: server('a'),
    connected: true,
    write: vi.fn()
  });
  registry.setActive({
    terminalId: 'terminal-b',
    server: server('b'),
    connected: false,
    write: vi.fn()
  });

  expect(registry.getSnapshot()).toEqual({
    focusedTerminal: {
      terminalId: 'terminal-b',
      serverId: 'b',
      label: 'b',
      host: 'b.example.com',
      port: 22,
      username: 'deploy',
      connected: false,
      focused: true,
      default: false
    },
    defaultConnectedTerminal: {
      terminalId: 'terminal-a',
      serverId: 'a',
      label: 'a',
      host: 'a.example.com',
      port: 22,
      username: 'deploy',
      connected: true,
      focused: false,
      default: true
    },
    connectedTerminals: [
      {
        terminalId: 'terminal-a',
        serverId: 'a',
        label: 'a',
        host: 'a.example.com',
        port: 22,
        username: 'deploy',
        connected: true,
        focused: false,
        default: true
      }
    ],
    knownTerminals: [
      {
        terminalId: 'terminal-a',
        serverId: 'a',
        label: 'a',
        host: 'a.example.com',
        port: 22,
        username: 'deploy',
        connected: true,
        focused: false,
        default: true
      },
      {
        terminalId: 'terminal-b',
        serverId: 'b',
        label: 'b',
        host: 'b.example.com',
        port: 22,
        username: 'deploy',
        connected: false,
        focused: true,
        default: false
      }
    ]
  });
});

it('resolves connected terminals by terminal id and server id', () => {
  const registry = new TerminalContextRegistry();
  registry.setActive({
    terminalId: 'terminal-a',
    server: server('a'),
    connected: true,
    write: vi.fn()
  });
  registry.setActive({
    terminalId: 'terminal-b',
    server: server('b'),
    connected: false,
    write: vi.fn()
  });

  expect(registry.getConnectedTerminalById('terminal-a')?.server.id).toBe('a');
  expect(registry.getConnectedTerminalById('terminal-b')).toBeUndefined();
  expect(registry.getConnectedTerminalByServerId('a')?.terminalId).toBe('terminal-a');
  expect(registry.getConnectedTerminalByServerId('b')).toBeUndefined();
});
```

- [ ] **Step 2: Run terminal context tests to verify failure**

Run: `cmd /c npm run test -- test/terminal/TerminalContext.test.ts`

Expected: FAIL because `getSnapshot`, `getConnectedTerminalById`, and `getConnectedTerminalByServerId` do not exist.

- [ ] **Step 3: Implement terminal snapshot types and helpers**

Modify `src/terminal/TerminalContext.ts` by adding these exported interfaces after `TerminalContext`:

```ts
export interface TerminalSummary {
  terminalId: string;
  serverId: string;
  label: string;
  host: string;
  port: number;
  username: string;
  connected: boolean;
  focused: boolean;
  default: boolean;
}

export interface TerminalContextSnapshot {
  focusedTerminal?: TerminalSummary;
  defaultConnectedTerminal?: TerminalSummary;
  connectedTerminals: TerminalSummary[];
  knownTerminals: TerminalSummary[];
}
```

Add these methods to `TerminalContextRegistry`:

```ts
  getConnectedTerminalById(terminalId: string | undefined): TerminalContext | undefined {
    if (!terminalId) {
      return undefined;
    }
    const context = this.contexts.get(terminalId);
    return context?.connected ? context : undefined;
  }

  getConnectedTerminalByServerId(serverId: string | undefined): TerminalContext | undefined {
    if (!serverId) {
      return undefined;
    }
    return Array.from(this.contexts.values())
      .reverse()
      .find((context) => context.connected && context.server.id === serverId);
  }

  getSnapshot(): TerminalContextSnapshot {
    const defaultConnected = this.getConnectedTerminal();
    const knownTerminals = Array.from(this.contexts.values()).map((context) =>
      this.toSummary(context, defaultConnected)
    );
    return {
      focusedTerminal: this.active ? this.toSummary(this.active, defaultConnected) : undefined,
      defaultConnectedTerminal: defaultConnected ? this.toSummary(defaultConnected, defaultConnected) : undefined,
      connectedTerminals: knownTerminals.filter((terminal) => terminal.connected),
      knownTerminals
    };
  }

  private toSummary(context: TerminalContext, defaultConnected: TerminalContext | undefined): TerminalSummary {
    return {
      terminalId: context.terminalId,
      serverId: context.server.id,
      label: context.server.label,
      host: context.server.host,
      port: context.server.port,
      username: context.server.username,
      connected: context.connected,
      focused: this.active?.terminalId === context.terminalId,
      default: defaultConnected?.terminalId === context.terminalId
    };
  }
```

- [ ] **Step 4: Run terminal context tests**

Run: `cmd /c npm run test -- test/terminal/TerminalContext.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit terminal context snapshot**

```bash
git add src/terminal/TerminalContext.ts test/terminal/TerminalContext.test.ts
git commit -m "feat: add terminal context snapshots"
```

## Task 2: Shared Agent Tool Service And Context Tool

**Files:**
- Create: `src/agent/AgentToolService.ts`
- Modify: `src/agent/AgentTools.ts`
- Modify: `src/mcp/BridgeProtocol.ts`
- Modify: `src/mcp/BridgeClient.ts`
- Modify: `src/mcp/BridgeServer.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `test/agent/AgentTools.test.ts`
- Modify: `test/mcp/BridgeServer.test.ts`
- Modify: `test/mcp/BridgeClient.test.ts`
- Add: `test/agent/AgentToolService.test.ts`
- Add: `test/mcp/McpServerTools.test.ts`
- Modify: `test/package.agent-tools.test.ts`

- [ ] **Step 1: Write failing shared service tests**

Create `test/agent/AgentToolService.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { AgentToolService } from '../../src/agent/AgentToolService';
import type { RemoteCommandExecutor } from '../../src/agent/RemoteCommandExecutor';
import type { ServerConfig } from '../../src/config/schema';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

function server(id = 'server-1'): ServerConfig {
  return {
    id,
    label: id === 'server-1' ? 'Production' : 'Staging',
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

describe('AgentToolService', () => {
  it('returns terminal context snapshots without credentials', async () => {
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'terminal-1',
      server: { ...server(), privateKeyPath: 'C:/secret/key' },
      connected: true,
      write: vi.fn()
    });
    const service = new AgentToolService({
      configManager: { listServers: async () => [] } as never,
      terminalContext,
      executor: { execute: vi.fn() } as unknown as RemoteCommandExecutor
    });

    await expect(service.getTerminalContext()).resolves.toEqual({
      focusedTerminal: {
        terminalId: 'terminal-1',
        serverId: 'server-1',
        label: 'Production',
        host: 'server-1.example.com',
        port: 22,
        username: 'deploy',
        connected: true,
        focused: true,
        default: true
      },
      defaultConnectedTerminal: {
        terminalId: 'terminal-1',
        serverId: 'server-1',
        label: 'Production',
        host: 'server-1.example.com',
        port: 22,
        username: 'deploy',
        connected: true,
        focused: true,
        default: true
      },
      connectedTerminals: [
        {
          terminalId: 'terminal-1',
          serverId: 'server-1',
          label: 'Production',
          host: 'server-1.example.com',
          port: 22,
          username: 'deploy',
          connected: true,
          focused: true,
          default: true
        }
      ],
      knownTerminals: [
        {
          terminalId: 'terminal-1',
          serverId: 'server-1',
          label: 'Production',
          host: 'server-1.example.com',
          port: 22,
          username: 'deploy',
          connected: true,
          focused: true,
          default: true
        }
      ]
    });
  });
});
```

- [ ] **Step 2: Run shared service test to verify failure**

Run: `cmd /c npm run test -- test/agent/AgentToolService.test.ts`

Expected: FAIL because `src/agent/AgentToolService.ts` does not exist.

- [ ] **Step 3: Implement `AgentToolService` for existing and context tools**

Create `src/agent/AgentToolService.ts`:

```ts
import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import type { TerminalContextRegistry, TerminalContextSnapshot } from '../terminal/TerminalContext';
import type { RemoteCommandExecutor, RemoteCommandResult } from './RemoteCommandExecutor';

export interface AgentToolServiceDependencies {
  configManager: ConfigManager;
  terminalContext: TerminalContextRegistry;
  executor: RemoteCommandExecutor;
}

export interface RunRemoteCommandInput {
  serverId?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export class AgentToolService {
  constructor(private readonly dependencies: AgentToolServiceDependencies) {}

  async listServers() {
    const servers = await this.dependencies.configManager.listServers();
    return {
      servers: servers.map((server) => ({
        id: server.id,
        label: server.label,
        host: server.host,
        port: server.port,
        username: server.username,
        authType: server.authType
      }))
    };
  }

  async getTerminalContext(): Promise<TerminalContextSnapshot> {
    return this.dependencies.terminalContext.getSnapshot();
  }

  async runRemoteCommand(input: RunRemoteCommandInput): Promise<RemoteCommandResult> {
    const command = input.command?.trim();
    if (!command) {
      throw new Error('Remote command cannot be empty.');
    }
    const server = await this.resolveServer(input.serverId);
    const warning = isObviouslyDestructive(command) ? '\n\nWarning: this command appears destructive.' : '';
    const answer = await vscode.window.showWarningMessage(
      `Run remote command on ${server.label} (${server.host})?\n\n${command}${warning}`,
      { modal: true },
      'Run Command'
    );
    if (answer !== 'Run Command') {
      throw new Error('Remote command was cancelled.');
    }
    return await this.dependencies.executor.execute(server, {
      command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes
    });
  }

  private async resolveServer(serverId: string | undefined): Promise<ServerConfig> {
    if (serverId === 'active' || !serverId) {
      const connected = this.dependencies.terminalContext.getConnectedTerminal();
      if (connected) {
        return connected.server;
      }
      if (serverId === 'active') {
        throw new Error('No connected active SSH terminal is available.');
      }
    }
    if (!serverId) {
      throw new Error('serverId is required when there is no connected active SSH terminal.');
    }
    const server = await this.dependencies.configManager.getServer(serverId);
    if (!server) {
      throw new Error(`SSH server "${serverId}" was not found.`);
    }
    return server;
  }
}

function isObviouslyDestructive(command: string): boolean {
  return /\b(rm\s+-[^\n]*r|mkfs|shutdown|reboot|poweroff|dd\s+if=)/i.test(command);
}
```

- [ ] **Step 4: Refactor Copilot tools to use `AgentToolService` and add `get_terminal_context`**

Modify `src/agent/AgentTools.ts` to:

```ts
import * as vscode from 'vscode';
import { AgentToolService, type RunRemoteCommandInput } from './AgentToolService';

export function registerAgentTools(service: AgentToolService): vscode.Disposable[] {
  return [
    vscode.lm.registerTool('list_ssh_servers', new JsonTool<object>(() => service.listServers())),
    vscode.lm.registerTool('get_terminal_context', new JsonTool<object>(() => service.getTerminalContext())),
    vscode.lm.registerTool('run_remote_command', new JsonTool<RunRemoteCommandInput>((input) =>
      service.runRemoteCommand(input)
    ))
  ];
}

class JsonTool<TInput extends object> implements vscode.LanguageModelTool<TInput> {
  constructor(private readonly invokeJson: (input: TInput) => Promise<unknown>) {}

  async invoke(options: vscode.LanguageModelToolInvocationOptions<TInput>): Promise<vscode.LanguageModelToolResult> {
    return jsonToolResult(await this.invokeJson((options.input ?? {}) as TInput));
  }
}

function jsonToolResult(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))
  ]);
}
```

- [ ] **Step 5: Wire service in extension activation**

Modify `src/extension.ts` imports:

```ts
import { AgentToolService } from './agent/AgentToolService';
```

Replace `registerAgentTools({ ... })` and `new BridgeServer({ ... })` with:

```ts
  const agentToolService = new AgentToolService({
    configManager,
    terminalContext,
    executor: remoteCommandExecutor
  });
  const agentToolDisposables = registerAgentTools(agentToolService);
  const bridgeServer = new BridgeServer(agentToolService);
```

- [ ] **Step 6: Add bridge protocol and client methods for context**

Modify `src/mcp/BridgeProtocol.ts`:

```ts
import type { TerminalContextSnapshot } from '../terminal/TerminalContext';

export type GetTerminalContextBridgeResponse = TerminalContextSnapshot;
```

Modify `src/mcp/BridgeClient.ts` imports and methods:

```ts
import type { GetTerminalContextBridgeResponse } from './BridgeProtocol';

  async getTerminalContext(): Promise<GetTerminalContextBridgeResponse> {
    return this.call<GetTerminalContextBridgeResponse>('/tools/get_terminal_context', {});
  }
```

- [ ] **Step 7: Add bridge endpoint for context**

Modify `src/mcp/BridgeServer.ts` constructor and dependencies to accept `AgentToolService`:

```ts
import type { AgentToolService } from '../agent/AgentToolService';

export class BridgeServer {
  private server: Server | undefined;
  private token = '';

  constructor(
    private readonly service: AgentToolService,
    private readonly home = homedir()
  ) {}
```

Create the handler with:

```ts
const handler = createBridgeRequestHandler({
  service: this.service,
  token: this.token
});
```

Replace handler dependencies with:

```ts
export interface BridgeHandlerDependencies {
  service: AgentToolService;
  token: string;
}
```

Inside the handler add:

```ts
      if (request.path === '/tools/get_terminal_context') {
        return json(200, await dependencies.service.getTerminalContext());
      }
```

Replace list/run branches with `dependencies.service.listServers()` and `dependencies.service.runRemoteCommand(input)`.

- [ ] **Step 8: Register MCP context tool**

Modify `src/mcp/server.ts` after `list_ssh_servers`:

```ts
server.registerTool(
  'get_terminal_context',
  {
    title: 'Get Terminal Context',
    description: 'Return focused, default connected, connected, and known AT Terminal SSH terminal contexts.',
    inputSchema: {}
  },
  async () => textResult(await bridge.getTerminalContext())
);
```

- [ ] **Step 9: Update package language model tool contribution**

Modify `package.json`:

Add activation event:

```json
"onLanguageModelTool:get_terminal_context"
```

Add a `contributes.languageModelTools` object:

```json
{
  "name": "get_terminal_context",
  "tags": ["ssh", "terminal", "read-only"],
  "canBeReferencedInPrompt": true,
  "toolReferenceName": "get_terminal_context",
  "displayName": "Get Terminal Context",
  "userDescription": "Show focused and default AT Terminal SSH terminal context.",
  "modelDescription": "Return focusedTerminal, defaultConnectedTerminal, connectedTerminals, and knownTerminals for AT Terminal SSH sessions without exposing credentials.",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

- [ ] **Step 10: Add failing adapter tests for context**

Update `test/agent/AgentTools.test.ts` with:

```ts
it('registers get_terminal_context and returns service JSON', async () => {
  const service = {
    listServers: vi.fn(),
    getTerminalContext: vi.fn(async () => ({ connectedTerminals: [], knownTerminals: [] })),
    runRemoteCommand: vi.fn()
  };
  registerAgentTools(service as never);

  const result = await registeredTool('get_terminal_context').invoke({ input: {} });

  expect(JSON.parse(text(result))).toEqual({ connectedTerminals: [], knownTerminals: [] });
});
```

Update `test/mcp/BridgeClient.test.ts` with:

```ts
it('calls terminal context bridge endpoint', async () => {
  const home = await tempHome();
  await writeBridgeDiscovery(home, { port: 12345, token: 'secret', pid: 1, updatedAt: 1 });
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ connectedTerminals: [], knownTerminals: [] })
  }));
  const client = new BridgeClient({ home, fetch: fetch as never });

  await expect(client.getTerminalContext()).resolves.toEqual({ connectedTerminals: [], knownTerminals: [] });
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/tools/get_terminal_context', expect.any(Object));
});
```

Update `test/mcp/BridgeServer.test.ts` to construct handler with `service`:

```ts
const handler = createBridgeRequestHandler({
  token: 'secret',
  service: {
    getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] }),
    listServers: async () => ({ servers: [] }),
    runRemoteCommand: vi.fn()
  } as never
});
```

Add:

```ts
it('returns terminal context through the bridge', async () => {
  const handler = createBridgeRequestHandler({
    token: 'secret',
    service: {
      getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] })
    } as never
  });

  await expect(call(handler, { path: '/tools/get_terminal_context', token: 'secret' })).resolves.toEqual({
    status: 200,
    body: { connectedTerminals: [], knownTerminals: [] }
  });
});
```

- [ ] **Step 11: Add MCP server manifest test for context tool**

Create `test/mcp/McpServerTools.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MCP server tool registrations', () => {
  it('registers terminal context tool', () => {
    const source = readFileSync('src/mcp/server.ts', 'utf8');

    expect(source).toContain("'get_terminal_context'");
    expect(source).toContain('bridge.getTerminalContext()');
  });
});
```

- [ ] **Step 12: Run context adapter tests**

Run:

```bash
cmd /c npm run test -- test/agent/AgentToolService.test.ts
cmd /c npm run test -- test/agent/AgentTools.test.ts
cmd /c npm run test -- test/mcp/BridgeClient.test.ts
cmd /c npm run test -- test/mcp/BridgeServer.test.ts
cmd /c npm run test -- test/mcp/McpServerTools.test.ts
cmd /c npm run test -- test/package.agent-tools.test.ts
```

Expected: PASS after implementation.

- [ ] **Step 13: Commit context tool**

```bash
git add src/agent/AgentToolService.ts src/agent/AgentTools.ts src/mcp/BridgeProtocol.ts src/mcp/BridgeClient.ts src/mcp/BridgeServer.ts src/mcp/server.ts src/extension.ts package.json test/agent/AgentToolService.test.ts test/agent/AgentTools.test.ts test/mcp/BridgeClient.test.ts test/mcp/BridgeServer.test.ts test/mcp/McpServerTools.test.ts test/package.agent-tools.test.ts
git commit -m "feat: add terminal context agent tool"
```

## Task 3: SFTP Agent Service And Write Authorization

**Files:**
- Create: `src/agent/SftpAgentService.ts`
- Create: `src/agent/SftpWriteAuthorizer.ts`
- Modify: `src/sftp/SftpSession.ts`
- Modify: `src/sftp/SftpManager.ts`
- Add: `test/agent/SftpAgentService.test.ts`
- Add: `test/agent/SftpWriteAuthorizer.test.ts`

- [ ] **Step 1: Write failing authorizer tests**

Create `test/agent/SftpWriteAuthorizer.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { SftpWriteAuthorizer } from '../../src/agent/SftpWriteAuthorizer';
import type { ServerConfig } from '../../src/config/schema';

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'Production',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('SftpWriteAuthorizer', () => {
  it('prompts only once per server when approved', async () => {
    const confirm = vi.fn(async () => true);
    const authorizer = new SftpWriteAuthorizer(confirm);

    await expect(authorizer.requireWrite(server(), { operation: 'write_file', path: '/app/a.txt', overwrite: true })).resolves.toBeUndefined();
    await expect(authorizer.requireWrite(server(), { operation: 'create_file', path: '/app/b.txt', overwrite: false })).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(server(), { operation: 'write_file', path: '/app/a.txt', overwrite: true });
  });

  it('throws when user cancels authorization', async () => {
    const authorizer = new SftpWriteAuthorizer(async () => false);

    await expect(authorizer.requireWrite(server(), {
      operation: 'write_file',
      path: '/app/a.txt',
      overwrite: false
    })).rejects.toThrow('SFTP write was cancelled.');
  });
});
```

- [ ] **Step 2: Write failing SFTP agent service tests**

Create `test/agent/SftpAgentService.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { SftpAgentService } from '../../src/agent/SftpAgentService';
import type { ServerConfig } from '../../src/config/schema';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

function server(id = 'server-1'): ServerConfig {
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

function connectedRegistry(): TerminalContextRegistry {
  const registry = new TerminalContextRegistry();
  registry.setActive({
    terminalId: 'terminal-1',
    server: server(),
    connected: true,
    write: vi.fn()
  });
  return registry;
}

describe('SftpAgentService', () => {
  it('lists a directory using the default connected terminal', async () => {
    const session = {
      connect: vi.fn(async () => undefined),
      realpath: vi.fn(async () => '/home/deploy'),
      listDirectory: vi.fn(async () => [
        { name: 'app.js', path: '/home/deploy/app.js', type: 'file', size: 10, modifiedAt: 1 }
      ]),
      stat: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      createFile: vi.fn(),
      dispose: vi.fn()
    };
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: { requireWrite: vi.fn() }
    });

    await expect(service.listDirectory({ path: '.' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy',
      entries: [{ name: 'app.js', path: '/home/deploy/app.js', type: 'file', size: 10, modifiedAt: 1 }]
    });
  });

  it('reads bounded UTF-8 text and reports truncation', async () => {
    const content = Buffer.from('hello world', 'utf8');
    const session = {
      connect: vi.fn(async () => undefined),
      realpath: vi.fn(async (path = '.') => (path === '.' ? '/home/deploy' : path)),
      listDirectory: vi.fn(),
      stat: vi.fn(async () => ({ size: content.length, modifiedAt: 123 })),
      readFile: vi.fn(async () => content),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      createFile: vi.fn(),
      dispose: vi.fn()
    };
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: { requireWrite: vi.fn() }
    });

    await expect(service.readFile({ path: '/home/deploy/app.txt', maxBytes: 5 })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy/app.txt',
      content: 'hello',
      truncated: true,
      size: 11,
      modifiedAt: 123
    });
  });

  it('rejects binary-looking file content', async () => {
    const session = {
      connect: vi.fn(async () => undefined),
      realpath: vi.fn(async (path = '.') => path),
      listDirectory: vi.fn(),
      stat: vi.fn(async () => ({ size: 3, modifiedAt: 1 })),
      readFile: vi.fn(async () => Buffer.from([0x61, 0x00, 0x62])),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      createFile: vi.fn(),
      dispose: vi.fn()
    };
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: { requireWrite: vi.fn() }
    });

    await expect(service.readFile({ path: '/bin.dat' })).rejects.toThrow('Remote file appears to be binary.');
  });

  it('requires authorization and overwrite flag before writing existing files', async () => {
    const requireWrite = vi.fn(async () => undefined);
    const session = {
      connect: vi.fn(async () => undefined),
      realpath: vi.fn(async (path = '.') => path),
      listDirectory: vi.fn(),
      stat: vi.fn(async () => ({ size: 4, modifiedAt: 1 })),
      readFile: vi.fn(),
      writeFile: vi.fn(async () => undefined),
      mkdir: vi.fn(),
      createFile: vi.fn(),
      dispose: vi.fn()
    };
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: { requireWrite }
    });

    await expect(service.writeFile({ path: '/app.txt', content: 'next' })).rejects.toThrow(
      'Remote file already exists. Pass overwrite: true to replace it.'
    );
    await expect(service.writeFile({ path: '/app.txt', content: 'next', overwrite: true })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/app.txt',
      bytesWritten: 4,
      overwritten: true
    });
    expect(requireWrite).toHaveBeenCalledTimes(1);
    expect(session.writeFile).toHaveBeenCalledWith('/app.txt', Buffer.from('next', 'utf8'));
  });
});
```

- [ ] **Step 3: Run SFTP service tests to verify failure**

Run:

```bash
cmd /c npm run test -- test/agent/SftpWriteAuthorizer.test.ts
cmd /c npm run test -- test/agent/SftpAgentService.test.ts
```

Expected: FAIL because the new files and SFTP session methods do not exist.

- [ ] **Step 4: Add SFTP session file read/write methods**

Modify `src/sftp/SftpSession.ts`.

Add methods before `dispose()`:

```ts
  async readFile(path: string, maxBytes: number): Promise<Buffer> {
    const sftp = this.requireSftp();
    const handle = await new Promise<Buffer>((resolve, reject) => {
      sftp.open(path, 'r', (error, fileHandle) => (error ? reject(error) : resolve(fileHandle)));
    });
    try {
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < maxBytes) {
        const length = Math.min(32_768, maxBytes - offset);
        const buffer = Buffer.alloc(length);
        const bytesRead = await new Promise<number>((resolve, reject) => {
          sftp.read(handle, buffer, 0, length, offset, (error, read) => (error ? reject(error) : resolve(read)));
        });
        if (bytesRead <= 0) {
          break;
        }
        chunks.push(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return Buffer.concat(chunks);
    } finally {
      await new Promise<void>((resolve, reject) => {
        sftp.close(handle, (error) => (error ? reject(error) : resolve()));
      });
    }
  }

  async writeFile(path: string, content: Buffer): Promise<void> {
    const sftp = this.requireSftp();
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(path, { encoding: 'binary' });
      stream.once('error', reject);
      stream.once('finish', () => resolve());
      stream.end(content);
    });
  }
```

Modify `src/sftp/SftpManager.ts` `SftpSessionLike` interface:

```ts
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
```

- [ ] **Step 5: Implement write authorizer**

Create `src/agent/SftpWriteAuthorizer.ts`:

```ts
import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';

export interface SftpWriteRequest {
  operation: 'write_file' | 'create_file' | 'create_directory';
  path: string;
  overwrite: boolean;
}

export type ConfirmSftpWrite = (server: ServerConfig, request: SftpWriteRequest) => Promise<boolean>;

export class SftpWriteAuthorizer {
  private readonly approvedServerIds = new Set<string>();

  constructor(private readonly confirm: ConfirmSftpWrite = confirmWithVscode) {}

  async requireWrite(server: ServerConfig, request: SftpWriteRequest): Promise<void> {
    if (this.approvedServerIds.has(server.id)) {
      return;
    }
    if (!(await this.confirm(server, request))) {
      throw new Error('SFTP write was cancelled.');
    }
    this.approvedServerIds.add(server.id);
  }
}

async function confirmWithVscode(server: ServerConfig, request: SftpWriteRequest): Promise<boolean> {
  const overwrite = request.overwrite ? '\nOverwrite: yes' : '\nOverwrite: no';
  const answer = await vscode.window.showWarningMessage(
    `Allow AT Terminal agent SFTP write on ${server.label} (${server.host})?\n\nOperation: ${request.operation}\nPath: ${request.path}${overwrite}`,
    { modal: true },
    'Allow SFTP Write'
  );
  return answer === 'Allow SFTP Write';
}
```

- [ ] **Step 6: Implement SFTP agent service**

Create `src/agent/SftpAgentService.ts`:

```ts
import type { ServerConfig } from '../config/schema';
import type { SftpEntry, SftpFileStat } from '../sftp/SftpTypes';
import type { TerminalContext, TerminalContextRegistry } from '../terminal/TerminalContext';
import type { SftpWriteAuthorizer } from './SftpWriteAuthorizer';

export interface AgentSftpSession {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  stat(path: string): Promise<SftpFileStat>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  dispose(): void;
}

export interface SftpAgentServiceOptions {
  terminalContext: TerminalContextRegistry;
  createSession(context: TerminalContext): AgentSftpSession;
  authorizer: Pick<SftpWriteAuthorizer, 'requireWrite'>;
}

export interface SftpTargetInput {
  terminalId?: string;
  serverId?: string;
}

const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;

export class SftpAgentService {
  private readonly sessions = new Map<string, Promise<AgentSftpSession>>();
  private readonly roots = new Map<string, string>();

  constructor(private readonly options: SftpAgentServiceOptions) {}

  async listDirectory(input: SftpTargetInput & { path?: string }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolvePath(target.context.terminalId, session, input.path);
    return {
      terminalId: target.context.terminalId,
      serverId: target.context.server.id,
      path,
      entries: await session.listDirectory(path)
    };
  }

  async statPath(input: SftpTargetInput & { path: string }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolvePath(target.context.terminalId, session, input.path);
    return {
      terminalId: target.context.terminalId,
      serverId: target.context.server.id,
      path,
      ...(await session.stat(path))
    };
  }

  async readFile(input: SftpTargetInput & { path: string; maxBytes?: number }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolvePath(target.context.terminalId, session, input.path);
    const stat = await session.stat(path);
    const maxBytes = clampReadBytes(input.maxBytes);
    const buffer = await session.readFile(path, Math.min(stat.size, maxBytes));
    if (looksBinary(buffer)) {
      throw new Error('Remote file appears to be binary.');
    }
    return {
      terminalId: target.context.terminalId,
      serverId: target.context.server.id,
      path,
      content: buffer.toString('utf8'),
      truncated: stat.size > maxBytes,
      size: stat.size,
      modifiedAt: stat.modifiedAt
    };
  }

  async writeFile(input: SftpTargetInput & { path: string; content: string; overwrite?: boolean }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolveWritablePath(target.context.terminalId, session, input.path);
    const exists = await pathExists(session, path);
    if (exists && !input.overwrite) {
      throw new Error('Remote file already exists. Pass overwrite: true to replace it.');
    }
    await this.options.authorizer.requireWrite(target.context.server, {
      operation: 'write_file',
      path,
      overwrite: Boolean(exists)
    });
    const content = Buffer.from(input.content, 'utf8');
    await session.writeFile(path, content);
    return {
      terminalId: target.context.terminalId,
      serverId: target.context.server.id,
      path,
      bytesWritten: content.length,
      overwritten: exists
    };
  }

  async createFile(input: SftpTargetInput & { path: string; content?: string }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolveWritablePath(target.context.terminalId, session, input.path);
    if (await pathExists(session, path)) {
      throw new Error('Remote file already exists.');
    }
    await this.options.authorizer.requireWrite(target.context.server, {
      operation: 'create_file',
      path,
      overwrite: false
    });
    if (input.content === undefined) {
      await session.createFile(path);
    } else {
      await session.writeFile(path, Buffer.from(input.content, 'utf8'));
    }
    return { terminalId: target.context.terminalId, serverId: target.context.server.id, path };
  }

  async createDirectory(input: SftpTargetInput & { path: string }) {
    const target = await this.resolveTarget(input);
    const session = await this.ensureSession(target.context);
    const path = await this.resolveWritablePath(target.context.terminalId, session, input.path);
    await this.options.authorizer.requireWrite(target.context.server, {
      operation: 'create_directory',
      path,
      overwrite: false
    });
    await session.mkdir(path);
    return { terminalId: target.context.terminalId, serverId: target.context.server.id, path };
  }

  dispose(): void {
    for (const sessionPromise of this.sessions.values()) {
      void sessionPromise.then((session) => session.dispose(), () => undefined);
    }
    this.sessions.clear();
    this.roots.clear();
  }

  private async resolveTarget(input: SftpTargetInput): Promise<{ context: TerminalContext; server: ServerConfig }> {
    const context =
      this.options.terminalContext.getConnectedTerminalById(input.terminalId) ??
      this.options.terminalContext.getConnectedTerminalByServerId(input.serverId) ??
      (!input.terminalId && !input.serverId ? this.options.terminalContext.getConnectedTerminal() : undefined);
    if (!context) {
      throw new Error('No matching connected AT Terminal SSH session is available. Connect an AT Terminal session first.');
    }
    return { context, server: context.server };
  }

  private async ensureSession(context: TerminalContext): Promise<AgentSftpSession> {
    const existing = this.sessions.get(context.terminalId);
    if (existing) {
      return await existing;
    }
    const session = this.options.createSession(context);
    const promise = Promise.resolve()
      .then(async () => {
        await session.connect();
        return session;
      })
      .catch((error) => {
        session.dispose();
        this.sessions.delete(context.terminalId);
        throw error;
      });
    this.sessions.set(context.terminalId, promise);
    return await promise;
  }

  private async resolvePath(terminalId: string, session: AgentSftpSession, path: string | undefined): Promise<string> {
    const root = await this.rootFor(terminalId, session);
    if (!path || path === '.') {
      return root;
    }
    return path.startsWith('/') ? await session.realpath(path) : await session.realpath(`${root}/${path}`);
  }

  private async resolveWritablePath(terminalId: string, session: AgentSftpSession, path: string): Promise<string> {
    if (!path.trim()) {
      throw new Error('Remote path cannot be empty.');
    }
    const resolved = await this.resolvePath(terminalId, session, path);
    if (resolved === '/') {
      throw new Error('Remote root path cannot be modified.');
    }
    return resolved;
  }

  private async rootFor(terminalId: string, session: AgentSftpSession): Promise<string> {
    const existing = this.roots.get(terminalId);
    if (existing) {
      return existing;
    }
    const root = await session.realpath('.');
    this.roots.set(terminalId, root);
    return root;
  }
}

async function pathExists(session: AgentSftpSession, path: string): Promise<boolean> {
  try {
    await session.stat(path);
    return true;
  } catch {
    return false;
  }
}

function clampReadBytes(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return DEFAULT_READ_BYTES;
  }
  return Math.min(value, MAX_READ_BYTES);
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}
```

- [ ] **Step 7: Run SFTP service tests**

Run:

```bash
cmd /c npm run test -- test/agent/SftpWriteAuthorizer.test.ts
cmd /c npm run test -- test/agent/SftpAgentService.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit SFTP core services**

```bash
git add src/agent/SftpAgentService.ts src/agent/SftpWriteAuthorizer.ts src/sftp/SftpSession.ts src/sftp/SftpManager.ts test/agent/SftpAgentService.test.ts test/agent/SftpWriteAuthorizer.test.ts
git commit -m "feat: add agent sftp service"
```

## Task 4: Expose SFTP Tools Through Copilot And MCP

**Files:**
- Modify: `src/agent/AgentToolService.ts`
- Modify: `src/agent/AgentTools.ts`
- Modify: `src/mcp/BridgeProtocol.ts`
- Modify: `src/mcp/BridgeClient.ts`
- Modify: `src/mcp/BridgeServer.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `test/agent/AgentToolService.test.ts`
- Modify: `test/agent/AgentTools.test.ts`
- Modify: `test/mcp/BridgeClient.test.ts`
- Modify: `test/mcp/BridgeServer.test.ts`
- Modify: `test/mcp/McpServerTools.test.ts`
- Modify: `test/package.agent-tools.test.ts`

- [ ] **Step 1: Extend service dependencies and methods for SFTP**

Modify `src/agent/AgentToolService.ts` imports:

```ts
import type { SftpAgentService } from './SftpAgentService';
```

Add dependency:

```ts
  sftp?: SftpAgentService;
```

Add methods:

```ts
  async sftpListDirectory(input: { terminalId?: string; serverId?: string; path?: string }) {
    return await this.requireSftp().listDirectory(input);
  }

  async sftpStatPath(input: { terminalId?: string; serverId?: string; path: string }) {
    return await this.requireSftp().statPath(input);
  }

  async sftpReadFile(input: { terminalId?: string; serverId?: string; path: string; maxBytes?: number }) {
    return await this.requireSftp().readFile(input);
  }

  async sftpWriteFile(input: { terminalId?: string; serverId?: string; path: string; content: string; overwrite?: boolean }) {
    return await this.requireSftp().writeFile(input);
  }

  async sftpCreateFile(input: { terminalId?: string; serverId?: string; path: string; content?: string }) {
    return await this.requireSftp().createFile(input);
  }

  async sftpCreateDirectory(input: { terminalId?: string; serverId?: string; path: string }) {
    return await this.requireSftp().createDirectory(input);
  }

  private requireSftp(): SftpAgentService {
    if (!this.dependencies.sftp) {
      throw new Error('AT Terminal SFTP agent service is not available.');
    }
    return this.dependencies.sftp;
  }
```

- [ ] **Step 2: Wire SFTP service in extension**

Modify `src/extension.ts` imports:

```ts
import { SftpAgentService } from './agent/SftpAgentService';
import { SftpWriteAuthorizer } from './agent/SftpWriteAuthorizer';
```

After `remoteCommandExecutor`:

```ts
  const sftpWriteAuthorizer = new SftpWriteAuthorizer();
  const sftpAgentService = new SftpAgentService({
    terminalContext,
    createSession: (terminal) => new SftpSession(terminal.server, configManager),
    authorizer: sftpWriteAuthorizer
  });
  const agentToolService = new AgentToolService({
    configManager,
    terminalContext,
    executor: remoteCommandExecutor,
    sftp: sftpAgentService
  });
```

Add `sftpAgentService` to `context.subscriptions.push(...)`.

- [ ] **Step 3: Register Copilot SFTP tools**

Modify `src/agent/AgentTools.ts` registration array:

```ts
    vscode.lm.registerTool('sftp_list_directory', new JsonTool((input) => service.sftpListDirectory(input as never))),
    vscode.lm.registerTool('sftp_stat_path', new JsonTool((input) => service.sftpStatPath(input as never))),
    vscode.lm.registerTool('sftp_read_file', new JsonTool((input) => service.sftpReadFile(input as never))),
    vscode.lm.registerTool('sftp_write_file', new JsonTool((input) => service.sftpWriteFile(input as never))),
    vscode.lm.registerTool('sftp_create_file', new JsonTool((input) => service.sftpCreateFile(input as never))),
    vscode.lm.registerTool('sftp_create_directory', new JsonTool((input) => service.sftpCreateDirectory(input as never)))
```

- [ ] **Step 4: Add SFTP bridge protocol and client methods**

Modify `src/mcp/BridgeProtocol.ts`:

```ts
export interface SftpTargetBridgeRequest {
  terminalId?: string;
  serverId?: string;
}

export interface SftpPathBridgeRequest extends SftpTargetBridgeRequest {
  path: string;
}

export interface SftpListDirectoryBridgeRequest extends SftpTargetBridgeRequest {
  path?: string;
}

export interface SftpReadFileBridgeRequest extends SftpPathBridgeRequest {
  maxBytes?: number;
}

export interface SftpWriteFileBridgeRequest extends SftpPathBridgeRequest {
  content: string;
  overwrite?: boolean;
}

export interface SftpCreateFileBridgeRequest extends SftpPathBridgeRequest {
  content?: string;
}
```

Modify `src/mcp/BridgeClient.ts` methods:

```ts
  async sftpListDirectory(input: SftpListDirectoryBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_list_directory', input);
  }

  async sftpStatPath(input: SftpPathBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_stat_path', input);
  }

  async sftpReadFile(input: SftpReadFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_read_file', input);
  }

  async sftpWriteFile(input: SftpWriteFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_write_file', input);
  }

  async sftpCreateFile(input: SftpCreateFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_create_file', input);
  }

  async sftpCreateDirectory(input: SftpPathBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_create_directory', input);
  }
```

- [ ] **Step 5: Add SFTP bridge endpoints**

Modify `src/mcp/BridgeServer.ts` handler with branches:

```ts
      if (request.path === '/tools/sftp_list_directory') {
        return json(200, await dependencies.service.sftpListDirectory(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_stat_path') {
        return json(200, await dependencies.service.sftpStatPath(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_read_file') {
        return json(200, await dependencies.service.sftpReadFile(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_write_file') {
        return json(200, await dependencies.service.sftpWriteFile(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_create_file') {
        return json(200, await dependencies.service.sftpCreateFile(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_create_directory') {
        return json(200, await dependencies.service.sftpCreateDirectory(parseBody(request.body)));
      }
```

- [ ] **Step 6: Register MCP SFTP tools**

Modify `src/mcp/server.ts` with shared shape:

```ts
const sftpTargetSchema = {
  terminalId: z.string().optional().describe('Connected AT Terminal terminal id.'),
  serverId: z.string().optional().describe('Connected AT Terminal server id.')
};

const pathSchema = {
  ...sftpTargetSchema,
  path: z.string().min(1).describe('Remote POSIX path.')
};
```

Register:

```ts
server.registerTool('sftp_list_directory', {
  title: 'SFTP List Directory',
  description: 'List a remote directory through the selected AT Terminal SFTP session.',
  inputSchema: { ...sftpTargetSchema, path: z.string().optional() }
}, async (input) => textResult(await bridge.sftpListDirectory(input)));

server.registerTool('sftp_stat_path', {
  title: 'SFTP Stat Path',
  description: 'Return remote path metadata through AT Terminal SFTP.',
  inputSchema: pathSchema
}, async (input) => textResult(await bridge.sftpStatPath(input)));

server.registerTool('sftp_read_file', {
  title: 'SFTP Read File',
  description: 'Read bounded UTF-8 text from a remote file through AT Terminal SFTP.',
  inputSchema: { ...pathSchema, maxBytes: z.number().int().positive().optional() }
}, async (input) => textResult(await bridge.sftpReadFile(input)));

server.registerTool('sftp_write_file', {
  title: 'SFTP Write File',
  description: 'Write UTF-8 text to a remote file after AT Terminal write authorization.',
  inputSchema: { ...pathSchema, content: z.string(), overwrite: z.boolean().optional() }
}, async (input) => textResult(await bridge.sftpWriteFile(input)));

server.registerTool('sftp_create_file', {
  title: 'SFTP Create File',
  description: 'Create a new remote file through AT Terminal SFTP.',
  inputSchema: { ...pathSchema, content: z.string().optional() }
}, async (input) => textResult(await bridge.sftpCreateFile(input)));

server.registerTool('sftp_create_directory', {
  title: 'SFTP Create Directory',
  description: 'Create a new remote directory through AT Terminal SFTP.',
  inputSchema: pathSchema
}, async (input) => textResult(await bridge.sftpCreateDirectory(input)));
```

- [ ] **Step 7: Add package contributions for SFTP language model tools**

Modify `package.json` activation events:

```json
"onLanguageModelTool:sftp_list_directory",
"onLanguageModelTool:sftp_stat_path",
"onLanguageModelTool:sftp_read_file",
"onLanguageModelTool:sftp_write_file",
"onLanguageModelTool:sftp_create_file",
"onLanguageModelTool:sftp_create_directory"
```

Add six `contributes.languageModelTools` entries. Use these names exactly:

```json
"sftp_list_directory"
"sftp_stat_path"
"sftp_read_file"
"sftp_write_file"
"sftp_create_file"
"sftp_create_directory"
```

Each entry must include:

```json
"canBeReferencedInPrompt": true,
"toolReferenceName": "<same name>",
"tags": ["ssh", "sftp"]
```

For read-only tools also include `"read-only"` in tags. For write tools use `modelDescription` stating that AT Terminal prompts for first write authorization per server.

- [ ] **Step 8: Add adapter tests for SFTP tools**

Update `test/agent/AgentTools.test.ts`:

```ts
it('registers sftp tools and delegates to service', async () => {
  const service = {
    listServers: vi.fn(),
    getTerminalContext: vi.fn(),
    runRemoteCommand: vi.fn(),
    sftpListDirectory: vi.fn(async () => ({ entries: [] })),
    sftpStatPath: vi.fn(async () => ({ size: 1 })),
    sftpReadFile: vi.fn(async () => ({ content: 'x' })),
    sftpWriteFile: vi.fn(async () => ({ bytesWritten: 1 })),
    sftpCreateFile: vi.fn(async () => ({ path: '/x' })),
    sftpCreateDirectory: vi.fn(async () => ({ path: '/d' }))
  };
  registerAgentTools(service as never);

  expect(lmFixture().__getRegisteredTool('sftp_list_directory')).toBeDefined();
  expect(lmFixture().__getRegisteredTool('sftp_stat_path')).toBeDefined();
  expect(lmFixture().__getRegisteredTool('sftp_read_file')).toBeDefined();
  expect(lmFixture().__getRegisteredTool('sftp_write_file')).toBeDefined();
  expect(lmFixture().__getRegisteredTool('sftp_create_file')).toBeDefined();
  expect(lmFixture().__getRegisteredTool('sftp_create_directory')).toBeDefined();

  await registeredTool('sftp_read_file').invoke({ input: { path: '/x' } });
  expect(service.sftpReadFile).toHaveBeenCalledWith({ path: '/x' });
});
```

Update `test/mcp/BridgeClient.test.ts` with one representative endpoint per pattern:

```ts
it('calls sftp read and write bridge endpoints', async () => {
  const home = await tempHome();
  await writeBridgeDiscovery(home, { port: 12345, token: 'secret', pid: 1, updatedAt: 1 });
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true })
  }));
  const client = new BridgeClient({ home, fetch: fetch as never });

  await client.sftpReadFile({ path: '/app.txt' });
  await client.sftpWriteFile({ path: '/app.txt', content: 'next', overwrite: true });

  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/tools/sftp_read_file', expect.any(Object));
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/tools/sftp_write_file', expect.any(Object));
});
```

Update `test/mcp/McpServerTools.test.ts`:

```ts
it('registers first-batch sftp tools', () => {
  const source = readFileSync('src/mcp/server.ts', 'utf8');

  for (const tool of [
    'sftp_list_directory',
    'sftp_stat_path',
    'sftp_read_file',
    'sftp_write_file',
    'sftp_create_file',
    'sftp_create_directory'
  ]) {
    expect(source).toContain(`'${tool}'`);
  }
});
```

- [ ] **Step 9: Run SFTP adapter tests**

Run:

```bash
cmd /c npm run test -- test/agent/AgentToolService.test.ts
cmd /c npm run test -- test/agent/AgentTools.test.ts
cmd /c npm run test -- test/mcp/BridgeClient.test.ts
cmd /c npm run test -- test/mcp/BridgeServer.test.ts
cmd /c npm run test -- test/mcp/McpServerTools.test.ts
cmd /c npm run test -- test/package.agent-tools.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit exposed SFTP tools**

```bash
git add src/agent/AgentToolService.ts src/agent/AgentTools.ts src/mcp/BridgeProtocol.ts src/mcp/BridgeClient.ts src/mcp/BridgeServer.ts src/mcp/server.ts src/extension.ts package.json test/agent/AgentToolService.test.ts test/agent/AgentTools.test.ts test/mcp/BridgeClient.test.ts test/mcp/BridgeServer.test.ts test/mcp/McpServerTools.test.ts test/package.agent-tools.test.ts
git commit -m "feat: expose sftp agent tools"
```

## Task 5: MCP Config Installer Command

**Files:**
- Create: `src/mcp/McpConfigInstaller.ts`
- Add: `test/mcp/McpConfigInstaller.test.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing MCP config installer tests**

Create `test/mcp/McpConfigInstaller.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildContinueMcpConfig, installContinueMcpConfig } from '../../src/mcp/McpConfigInstaller';

describe('McpConfigInstaller', () => {
  it('builds Continue MCP config with normalized mcp server path', () => {
    expect(buildContinueMcpConfig('C:\\Users\\alan\\.vscode\\extensions\\local.at-terminal-0.2.9\\dist\\mcp-server.js'))
      .toContain('C:/Users/alan/.vscode/extensions/local.at-terminal-0.2.9/dist/mcp-server.js');
  });

  it('creates workspace Continue MCP config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-terminal-mcp-config-'));
    const configPath = join(root, '.continue', 'mcpServers', 'at-terminal.yaml');

    await installContinueMcpConfig({
      workspaceFolder: root,
      mcpServerPath: join(root, 'dist', 'mcp-server.js')
    });

    await expect(readFile(configPath, 'utf8')).resolves.toContain('dist/mcp-server.js');
  });

  it('replaces existing AT Terminal config file content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-terminal-mcp-config-'));
    const dir = join(root, '.continue', 'mcpServers');
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, 'at-terminal.yaml');
    await writeFile(configPath, 'old', 'utf8');

    await installContinueMcpConfig({
      workspaceFolder: root,
      mcpServerPath: join(root, 'dist', 'mcp-server.js')
    });

    await expect(readFile(configPath, 'utf8')).resolves.not.toBe('old');
  });
});
```

- [ ] **Step 2: Run MCP config installer tests to verify failure**

Run: `cmd /c npm run test -- test/mcp/McpConfigInstaller.test.ts`

Expected: FAIL because `src/mcp/McpConfigInstaller.ts` does not exist.

- [ ] **Step 3: Implement MCP config installer helpers**

Create `src/mcp/McpConfigInstaller.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface InstallContinueMcpConfigOptions {
  workspaceFolder: string;
  mcpServerPath: string;
}

export function buildContinueMcpConfig(mcpServerPath: string): string {
  const normalized = mcpServerPath.replaceAll('\\', '/');
  return `name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - ${normalized}
`;
}

export function continueMcpConfigPath(workspaceFolder: string): string {
  return join(workspaceFolder, '.continue', 'mcpServers', 'at-terminal.yaml');
}

export async function installContinueMcpConfig(options: InstallContinueMcpConfigOptions): Promise<string> {
  const target = continueMcpConfigPath(options.workspaceFolder);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buildContinueMcpConfig(options.mcpServerPath), 'utf8');
  return target;
}
```

- [ ] **Step 4: Register VS Code command**

Modify `src/extension.ts` imports:

```ts
import { installContinueMcpConfig } from './mcp/McpConfigInstaller';
```

Add command to `context.subscriptions.push(...)`:

```ts
    vscode.commands.registerCommand('sshManager.installMcpConfig', async () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceFolder) {
        await vscode.window.showErrorMessage('Open a workspace folder before installing AT Terminal MCP config.');
        return;
      }
      const mcpServerPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.js').fsPath;
      const target = await installContinueMcpConfig({ workspaceFolder, mcpServerPath });
      await vscode.window.showInformationMessage(`AT Terminal MCP config installed: ${target}`);
    })
```

- [ ] **Step 5: Add package command contribution**

Modify `package.json` `contributes.commands`:

```json
{
  "command": "sshManager.installMcpConfig",
  "title": "AT Terminal: Install MCP Config"
}
```

- [ ] **Step 6: Run config installer tests**

Run: `cmd /c npm run test -- test/mcp/McpConfigInstaller.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit MCP config installer**

```bash
git add src/mcp/McpConfigInstaller.ts src/extension.ts package.json test/mcp/McpConfigInstaller.test.ts
git commit -m "feat: add mcp config installer command"
```

## Task 6: Docs And Manual Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/manual-tests/at-terminal-mcp.md`
- Modify: `test/docs/McpDocs.test.ts`

- [ ] **Step 1: Write failing docs assertions**

Modify `test/docs/McpDocs.test.ts`:

```ts
expect(readme).toContain('get_terminal_context');
expect(readme).toContain('sftp_read_file');
expect(readme).toContain('AT Terminal: Install MCP Config');
expect(sample).toContain('mcpServers:');
```

- [ ] **Step 2: Run docs test to verify failure**

Run: `cmd /c npm run test -- test/docs/McpDocs.test.ts`

Expected: FAIL until README is updated.

- [ ] **Step 3: Update README agent tool section**

In `README.md`, update the English `#### Agent Tools` and `#### AT Terminal MCP` sections with:

```md
AT Terminal contributes VS Code language model tools and a local MCP server for compatible agents.

- `list_ssh_servers` lists configured server ids and connection metadata without exposing credentials.
- `get_terminal_context` returns `focusedTerminal`, `defaultConnectedTerminal`, `connectedTerminals`, and `knownTerminals`.
- `run_remote_command` runs a bounded command through SSH and returns stdout, stderr, exit code, timeout, duration, and truncation metadata.
- `sftp_list_directory`, `sftp_stat_path`, and `sftp_read_file` inspect remote files through the connected AT Terminal SFTP session.
- `sftp_write_file`, `sftp_create_file`, and `sftp_create_directory` write remote UTF-8 text or create remote paths after first-write authorization for that server.

Every remote command asks for confirmation before execution. SFTP write tools ask for confirmation the first time a server is written to during the current extension host session. Use `terminalId` or `serverId` to target a specific connected terminal, or omit both to use `defaultConnectedTerminal`.
```

Add command note:

```md
Run `AT Terminal: Install MCP Config` from the Command Palette to create `.continue/mcpServers/at-terminal.yaml` in the current workspace.
```

- [ ] **Step 4: Update manual MCP tests**

Modify `docs/superpowers/manual-tests/at-terminal-mcp.md` cases:

```md
4. Ask Continue Agent: `Use get_terminal_context to show my AT Terminal context.`
   - Expected: output includes focusedTerminal and defaultConnectedTerminal.

5. Ask Continue Agent: `Use sftp_list_directory to list the default connected terminal directory.`
   - Expected: output includes remote directory entries.

6. Ask Continue Agent: `Use sftp_write_file to write hello to /tmp/at-terminal-agent-test.txt.`
   - Expected: VS Code prompts for SFTP write authorization once.
   - Expected: approving writes the file.
   - Expected: a second write on the same server does not prompt again until reload.

7. Run `AT Terminal: Install MCP Config`.
   - Expected: `.continue/mcpServers/at-terminal.yaml` is created or replaced.
```

- [ ] **Step 5: Run docs test**

Run: `cmd /c npm run test -- test/docs/McpDocs.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit docs**

```bash
git add README.md test/docs/McpDocs.test.ts
git add -f docs/superpowers/manual-tests/at-terminal-mcp.md
git commit -m "docs: cover expanded agent tools"
```

## Task 7: Full Verification And VSIX Packaging

**Files:**
- No source files.
- Generated ignored artifact: `at-terminal-0.2.9.vsix`

- [ ] **Step 1: Run full test suite**

Run: `cmd /c npm test`

Expected: PASS for all Vitest tests.

- [ ] **Step 2: Run typecheck**

Run: `cmd /c npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run build**

Run: `cmd /c npm run build`

Expected: PASS and these files exist:

- `dist/extension.js`
- `dist/mcp-server.js`
- `dist/webview/terminal.js`
- `dist/webview/server-form.js`

- [ ] **Step 4: Package VSIX**

Run:

```bash
cmd /c npx @vscode/vsce package --baseContentUrl https://example.invalid/at-terminal/ --baseImagesUrl https://example.invalid/at-terminal/ --allow-missing-repository
```

Expected:

- PASS.
- `at-terminal-0.2.9.vsix` is roughly several MB, not around 100 KB.

- [ ] **Step 5: Verify VSIX contents**

Run:

```bash
cmd /c tar -tf at-terminal-0.2.9.vsix | findstr /R "extension/dist/mcp-server.js extension/node_modules/ssh2/package.json extension/package.json"
```

Expected output includes:

```text
extension/package.json
extension/dist/mcp-server.js
extension/node_modules/ssh2/package.json
```

- [ ] **Step 6: Inspect git state**

Run: `git status --short --ignored`

Expected:

- no tracked source changes;
- ignored `at-terminal-0.2.9.vsix`, `dist/`, `node_modules/`, and old ignored plan files may appear.

## Self-Review

- Spec coverage:
  - Terminal context read-only tool: Task 1 and Task 2.
  - `focusedTerminal` plus `defaultConnectedTerminal`: Task 1.
  - SFTP read/write first batch: Task 3 and Task 4.
  - Write authorization once per server per extension host session: Task 3.
  - MCP config explicit command: Task 5.
  - Docs and manual tests: Task 6.
  - Final verification and packaging: Task 7.
- Placeholder scan:
  - No `TBD`, `TODO`, or unresolved placeholder steps.
  - Cursor/Kiro automatic writes remain out of implementation scope per spec; Continue config command is implemented.
- Type consistency:
  - Tool names match across package contribution, Copilot registration, bridge endpoints, BridgeClient methods, and MCP server registrations.
  - SFTP request names use `terminalId`, `serverId`, `path`, `content`, `overwrite`, and `maxBytes` consistently.
  - Terminal summary fields match the design spec exactly.
