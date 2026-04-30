import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { registerAgentTools } from '../../src/agent/AgentTools';
import type { RemoteCommandExecutor } from '../../src/agent/RemoteCommandExecutor';
import type { ServerConfig } from '../../src/config/schema';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

interface ToolFixture {
  invoke(options: unknown): Promise<unknown>;
}

interface LmFixture {
  __getRegisteredTool(name: string): ToolFixture | undefined;
  __clearRegisteredTools(): void;
}

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

function lmFixture(): LmFixture {
  return vscode.lm as unknown as LmFixture;
}

function registeredTool(name: string): ToolFixture {
  const tool = lmFixture().__getRegisteredTool(name);
  if (!tool) {
    throw new Error(`Tool ${name} was not registered.`);
  }
  return tool;
}

function text(result: unknown): string {
  const toolResult = result as { content: Array<{ value: string }> };
  return toolResult.content[0].value;
}

beforeEach(() => {
  lmFixture().__clearRegisteredTools();
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Run Command' as never);
});

describe('registerAgentTools', () => {
  it('registers list and run tools', () => {
    registerAgentTools({
      configManager: { listServers: async () => [] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never
    });

    expect(lmFixture().__getRegisteredTool('sshManager.listServers')).toBeDefined();
    expect(lmFixture().__getRegisteredTool('sshManager.runRemoteCommand')).toBeDefined();
  });

  it('lists servers without exposing credentials', async () => {
    registerAgentTools({
      configManager: { listServers: async () => [server()] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never
    });

    const result = await registeredTool('sshManager.listServers').invoke({
      input: {}
    });

    expect(JSON.parse(text(result))).toEqual({
      servers: [
        {
          id: 'server-1',
          label: 'Production',
          host: 'server-1.example.com',
          port: 22,
          username: 'deploy',
          authType: 'password'
        }
      ]
    });
  });

  it('runs a command against an explicit server after user confirmation', async () => {
    const execute = vi.fn(async () => ({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command: 'uptime',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 12,
      timedOut: false,
      truncated: false
    }));
    registerAgentTools({
      configManager: {
        listServers: async () => [server()],
        getServer: async () => server()
      } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    const result = await registeredTool('sshManager.runRemoteCommand').invoke({
      input: {
        serverId: 'server-1',
        command: 'uptime',
        timeoutMs: 10_000
      }
    });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Run remote command on Production (server-1.example.com)?\n\nuptime',
      { modal: true },
      'Run Command'
    );
    expect(execute).toHaveBeenCalledWith(server(), {
      command: 'uptime',
      cwd: undefined,
      timeoutMs: 10_000,
      maxOutputBytes: undefined
    });
    expect(JSON.parse(text(result))).toMatchObject({ stdout: 'ok', exitCode: 0 });
  });

  it('resolves serverId active from the active terminal context', async () => {
    const registry = new TerminalContextRegistry();
    registry.setActive({
      terminalId: 'terminal-1',
      server: server('server-2'),
      connected: true,
      write: vi.fn()
    });
    const execute = vi.fn(async () => ({
      serverId: 'server-2',
      serverLabel: 'Staging',
      host: 'server-2.example.com',
      command: 'pwd',
      exitCode: 0,
      stdout: '/home/deploy\n',
      stderr: '',
      durationMs: 20,
      timedOut: false,
      truncated: false
    }));

    registerAgentTools({
      configManager: { listServers: async () => [], getServer: async () => undefined } as never,
      terminalContext: registry,
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await registeredTool('sshManager.runRemoteCommand').invoke({
      input: {
        serverId: 'active',
        command: 'pwd'
      }
    });

    expect(execute).toHaveBeenCalledWith(server('server-2'), {
      command: 'pwd',
      cwd: undefined,
      timeoutMs: undefined,
      maxOutputBytes: undefined
    });
  });

  it('throws when no server can be resolved', async () => {
    registerAgentTools({
      configManager: { listServers: async () => [], getServer: async () => undefined } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never
    });

    await expect(
      registeredTool('sshManager.runRemoteCommand').invoke({
        input: {
          serverId: 'missing',
          command: 'uptime'
        }
      })
    ).rejects.toThrow('SSH server "missing" was not found.');
  });

  it('throws when the user cancels command confirmation', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);
    registerAgentTools({
      configManager: { listServers: async () => [server()], getServer: async () => server() } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never
    });

    await expect(
      registeredTool('sshManager.runRemoteCommand').invoke({
        input: {
          serverId: 'server-1',
          command: 'uptime'
        }
      })
    ).rejects.toThrow('Remote command was cancelled.');
  });
});
