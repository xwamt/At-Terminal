import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
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

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AgentToolService', () => {
  it('lists only servers that allow background connections', async () => {
    const allowed = { ...server('server-1'), backgroundConnectionAllowed: true };
    const blocked = { ...server('server-2'), backgroundConnectionAllowed: false };
    const legacy = server('server-3');
    const service = new AgentToolService({
      configManager: { listServers: async () => [allowed, blocked, legacy] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as unknown as RemoteCommandExecutor
    });

    await expect(service.listServers()).resolves.toEqual({
      servers: [
        expect.objectContaining({
          id: 'server-1',
          agentCommandAutoApprove: false
        })
      ]
    });
  });

  it('rejects direct commands for servers without background authorization', async () => {
    const blocked = { ...server(), backgroundConnectionAllowed: false };
    const execute = vi.fn();
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage');
    const service = new AgentToolService({
      configManager: { getServer: async () => blocked, listServers: async () => [blocked] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await expect(service.runRemoteCommand({ serverId: 'server-1', command: 'uptime' })).rejects.toThrow(
      'SSH server "server-1" does not allow background connections.'
    );
    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('allows commands on a connected UI terminal without background authorization', async () => {
    const connectedServer = { ...server(), backgroundConnectionAllowed: false, agentCommandAutoApprove: true };
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'terminal-1',
      server: connectedServer,
      connected: true,
      write: vi.fn()
    });
    const execute = vi.fn(async () => ({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command: 'uptime',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false
    }));
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage');
    const service = new AgentToolService({
      configManager: { getServer: async () => connectedServer, listServers: async () => [connectedServer] } as never,
      terminalContext,
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await service.runRemoteCommand({ command: 'uptime' });
    await service.runRemoteCommand({ serverId: 'active', command: 'uptime' });
    await service.runRemoteCommand({ serverId: 'server-1', command: 'uptime' });

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledWith(connectedServer, expect.objectContaining({ command: 'uptime' }));
  });

  it('still requires background authorization when the requested server has no connected terminal', async () => {
    const blocked = { ...server('server-2'), backgroundConnectionAllowed: false };
    const connectedServer = { ...server('server-1'), backgroundConnectionAllowed: false, agentCommandAutoApprove: true };
    const terminalContext = new TerminalContextRegistry();
    terminalContext.setActive({
      terminalId: 'terminal-1',
      server: connectedServer,
      connected: true,
      write: vi.fn()
    });
    const execute = vi.fn();
    const service = new AgentToolService({
      configManager: { getServer: async (id: string) => (id === 'server-2' ? blocked : connectedServer), listServers: async () => [connectedServer, blocked] } as never,
      terminalContext,
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await expect(service.runRemoteCommand({ serverId: 'server-2', command: 'uptime' })).rejects.toThrow(
      'SSH server "server-2" does not allow background connections.'
    );
    expect(execute).not.toHaveBeenCalled();
  });

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

  it('delegates sftp operations to the sftp service', async () => {
    const sftp = {
      listDirectory: vi.fn(async () => ({ entries: [] })),
      statPath: vi.fn(async () => ({ size: 1 })),
      readFile: vi.fn(async () => ({ content: 'x' })),
      writeFile: vi.fn(async () => ({ bytesWritten: 1 })),
      createFile: vi.fn(async () => ({ path: '/x' })),
      createDirectory: vi.fn(async () => ({ path: '/d' }))
    };
    const service = new AgentToolService({
      configManager: { listServers: async () => [] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as unknown as RemoteCommandExecutor,
      sftp: sftp as never
    });

    await service.sftpReadFile({ path: '/x' });
    await service.sftpWriteFile({ path: '/x', content: 'next', overwrite: true });

    expect(sftp.readFile).toHaveBeenCalledWith({ path: '/x' });
    expect(sftp.writeFile).toHaveBeenCalledWith({ path: '/x', content: 'next', overwrite: true });
  });

  it('skips command confirmation for trusted non-destructive remote commands', async () => {
    const trusted = { ...server(), backgroundConnectionAllowed: true, agentCommandAutoApprove: true };
    const execute = vi.fn(async () => ({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command: 'uptime',
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false
    }));
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage');
    const service = new AgentToolService({
      configManager: { getServer: async () => trusted, listServers: async () => [trusted] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await service.runRemoteCommand({ serverId: 'server-1', command: 'uptime' });

    expect(showWarningMessage).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith(trusted, {
      command: 'uptime',
      cwd: undefined,
      timeoutMs: undefined,
      maxOutputBytes: undefined
    });
  });

  it('still confirms destructive commands for trusted servers', async () => {
    const trusted = { ...server(), backgroundConnectionAllowed: true, agentCommandAutoApprove: true };
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Run Command' as never);
    const execute = vi.fn(async () => ({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command: 'rm -rf /tmp/app',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false
    }));
    const service = new AgentToolService({
      configManager: { getServer: async () => trusted, listServers: async () => [trusted] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await service.runRemoteCommand({ serverId: 'server-1', command: 'rm -rf /tmp/app' });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Run remote command on Production (server-1.example.com)?\n\nrm -rf /tmp/app\n\nWarning: this command appears destructive.',
      { modal: true },
      'Run Command'
    );
    expect(execute).toHaveBeenCalled();
  });

  it('cancels destructive commands for trusted servers when the user declines', async () => {
    const trusted = { ...server(), backgroundConnectionAllowed: true, agentCommandAutoApprove: true };
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const execute = vi.fn();
    const service = new AgentToolService({
      configManager: { getServer: async () => trusted, listServers: async () => [trusted] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await expect(service.runRemoteCommand({ serverId: 'server-1', command: 'rm -rf /tmp/app' })).rejects.toThrow(
      'Remote command was cancelled.'
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('truncates long remote command previews in the confirmation modal', async () => {
    const longCommand = Array.from({ length: 30 }, (_, i) => `echo line-${i}`).join('\n');
    const authorized = { ...server(), backgroundConnectionAllowed: true };
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Run Command' as never);
    const execute = vi.fn(async () => ({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command: longCommand,
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1,
      timedOut: false,
      truncated: false
    }));
    const service = new AgentToolService({
      configManager: { getServer: async () => authorized, listServers: async () => [authorized] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor
    });

    await service.runRemoteCommand({ serverId: 'server-1', command: longCommand });

    const message = vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0] as string;
    expect(message).toContain('echo line-0');
    expect(message).toContain('… (truncated,');
    expect(message).not.toContain('echo line-29');
    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ command: longCommand })
    );
  });
});
