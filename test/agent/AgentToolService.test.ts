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
});
