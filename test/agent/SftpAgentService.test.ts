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
