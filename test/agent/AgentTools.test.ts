import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AgentToolService } from '../../src/agent/AgentToolService';
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

function registerTestAgentTools(dependencies: ConstructorParameters<typeof AgentToolService>[0]): void {
  registerAgentTools(new AgentToolService(dependencies));
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
    registerTestAgentTools({
      configManager: { listServers: async () => [] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never
    });

    expect(lmFixture().__getRegisteredTool('list_ssh_servers')).toBeDefined();
    expect(lmFixture().__getRegisteredTool('get_terminal_context')).toBeDefined();
    expect(lmFixture().__getRegisteredTool('run_remote_command')).toBeDefined();
  });

  it('lists servers without exposing credentials', async () => {
    registerTestAgentTools({
      configManager: { listServers: async () => [server()] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never
    });

    const result = await registeredTool('list_ssh_servers').invoke({
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
    registerTestAgentTools({
      configManager: {
        listServers: async () => [server()],
        getServer: async () => server()
      } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    const result = await registeredTool('run_remote_command').invoke({
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

    registerTestAgentTools({
      configManager: { listServers: async () => [], getServer: async () => undefined } as never,
      terminalContext: registry,
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await registeredTool('run_remote_command').invoke({
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

  it('uses the most recent connected terminal when the active panel is disconnected', async () => {
    const registry = new TerminalContextRegistry();
    registry.setActive({
      terminalId: 'terminal-connected',
      server: server('server-2'),
      connected: true,
      write: vi.fn()
    });
    registry.setActive({
      terminalId: 'terminal-disconnected',
      server: server('server-1'),
      connected: false,
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

    registerTestAgentTools({
      configManager: { listServers: async () => [], getServer: async () => undefined } as never,
      terminalContext: registry,
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await registeredTool('run_remote_command').invoke({
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
    registerTestAgentTools({
      configManager: { listServers: async () => [], getServer: async () => undefined } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never
    });

    await expect(
      registeredTool('run_remote_command').invoke({
        input: {
          serverId: 'missing',
          command: 'uptime'
        }
      })
    ).rejects.toThrow('SSH server "missing" was not found.');
  });

  it('throws when the user cancels command confirmation', async () => {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(undefined);
    registerTestAgentTools({
      configManager: { listServers: async () => [server()], getServer: async () => server() } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never
    });

    await expect(
      registeredTool('run_remote_command').invoke({
        input: {
          serverId: 'server-1',
          command: 'uptime'
        }
      })
    ).rejects.toThrow('Remote command was cancelled.');
  });

  it('adds a destructive warning for obviously dangerous commands', async () => {
    registerTestAgentTools({
      configManager: { listServers: async () => [server()], getServer: async () => server() } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: {
        execute: vi.fn(async () => ({
          serverId: 'server-1',
          serverLabel: 'Production',
          host: 'server-1.example.com',
          command: 'rm -rf /var/www/app',
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 5,
          timedOut: false,
          truncated: false
        }))
      } as never
    });

    await registeredTool('run_remote_command').invoke({
      input: {
        serverId: 'server-1',
        command: 'rm -rf /var/www/app'
      }
    });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Run remote command on Production (server-1.example.com)?\n\nrm -rf /var/www/app\n\nWarning: this command appears destructive.',
      { modal: true },
      'Run Command'
    );
  });
});
