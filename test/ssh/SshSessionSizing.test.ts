import { describe, expect, it, vi } from 'vitest';
import { SshSession } from '../../src/ssh/SshSession';
import type { ServerConfig } from '../../src/config/schema';

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'Production',
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

describe('SshSession terminal sizing', () => {
  it('uses the latest xterm size when opening a shell', () => {
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() }
    );

    session.resize(37, 141);

    expect(session.getShellOptions()).toEqual({
      term: 'xterm-256color',
      rows: 37,
      cols: 141
    });
  });

  it('requests color-capable shell environment for remote auto-color commands', () => {
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() }
    );

    expect(session.getShellEnvironment()).toEqual({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CLICOLOR: '1',
      FORCE_COLOR: '1'
    });
  });
});
