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
