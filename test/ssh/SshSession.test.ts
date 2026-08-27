import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SshSession } from '../../src/ssh/SshSession';
import type { ServerConfig } from '../../src/config/schema';

type MockShell = EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  setWindow: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
};

const sshSessionMocks = vi.hoisted(() => ({
  disposeHandle: vi.fn(),
  connect: vi.fn(function (this: { handlers?: Record<string, () => void> }) {
    this.handlers?.ready?.();
  }),
  end: vi.fn(),
  shells: [] as unknown[]
}));

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectionHandle: vi.fn(async () => ({
    config: { host: 'example.com', port: 22 },
    dispose: sshSessionMocks.disposeHandle
  }))
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const shell = new EventEmitter() as MockShell;
    shell.end = vi.fn();
    shell.write = vi.fn();
    shell.setWindow = vi.fn();
    shell.pause = vi.fn();
    shell.resume = vi.fn();
    sshSessionMocks.shells.push(shell);
    const client = {
      handlers: {} as Record<string, (...args: never[]) => void>,
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        client.handlers[event] = handler;
        return client;
      }),
      once: vi.fn((event: string, handler: (...args: never[]) => void) => {
        client.handlers[event] = handler;
        return client;
      }),
      connect: sshSessionMocks.connect,
      end: sshSessionMocks.end,
      shell: vi.fn((_options, _extraOptions, callback) => callback(undefined, shell))
    };
    return client;
  })
}));

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

function latestShell(): MockShell {
  return sshSessionMocks.shells[sshSessionMocks.shells.length - 1] as MockShell;
}

beforeEach(() => {
  sshSessionMocks.disposeHandle.mockClear();
  sshSessionMocks.connect.mockClear();
  sshSessionMocks.end.mockClear();
  sshSessionMocks.shells.length = 0;
  sshSessionMocks.connect.mockImplementation(function (this: { handlers?: Record<string, () => void> }) {
    this.handlers?.ready?.();
  });
});

describe('SshSession host key verification', () => {
  it('tracks connection state as disconnected before connect and after dispose', () => {
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() },
      { verify: async () => true }
    );

    expect(session.isConnected()).toBe(false);
    session.dispose();
    expect(session.isConnected()).toBe(false);
  });

  it('disposes the SSH connection handle when the session is disposed', async () => {
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() },
      { verify: async () => true }
    );

    await session.connect();
    session.dispose();

    expect(sshSessionMocks.end).toHaveBeenCalledTimes(1);
    expect(sshSessionMocks.disposeHandle).toHaveBeenCalledTimes(1);
  });
});

describe('SshSession structured status', () => {
  it('emits connecting and connected states with display text', async () => {
    const status = vi.fn();
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status, error: vi.fn() },
      { verify: async () => true }
    );

    await session.connect();

    expect(status).toHaveBeenNthCalledWith(1, {
      state: 'connecting',
      text: 'Connecting to example.com:22...'
    });
    expect(status).toHaveBeenNthCalledWith(2, { state: 'connected', text: 'Connected' });
  });

  it('emits a disconnected state when the shell closes', async () => {
    const status = vi.fn();
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status, error: vi.fn() },
      { verify: async () => true }
    );

    await session.connect();
    latestShell().emit('close');

    expect(session.isConnected()).toBe(false);
    expect(status).toHaveBeenLastCalledWith({ state: 'disconnected', text: 'Disconnected' });
  });
});

describe('SshSession output flow control', () => {
  it('pauses and resumes the shell channel', async () => {
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() },
      { verify: async () => true }
    );

    await session.connect();
    session.pauseOutput();
    session.resumeOutput();

    expect(latestShell().pause).toHaveBeenCalledTimes(1);
    expect(latestShell().resume).toHaveBeenCalledTimes(1);
  });

  it('is safe to call before a shell exists', () => {
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() },
      { verify: async () => true }
    );

    expect(() => {
      session.pauseOutput();
      session.resumeOutput();
    }).not.toThrow();
  });
});

describe('SshSession keyboard-interactive authentication', () => {
  function connectTriggersKeyboardInteractive(): void {
    sshSessionMocks.connect.mockImplementationOnce(function (this: {
      handlers: Record<string, (...args: never[]) => void>;
    }) {
      const handler = this.handlers['keyboard-interactive'] as unknown as (
        name: string,
        instructions: string,
        lang: string,
        prompts: Array<{ prompt: string; echo?: boolean }>,
        finish: (responses: string[]) => void
      ) => void;
      handler('2FA', '', '', [{ prompt: 'Verification code:', echo: false }], () => {
        this.handlers.ready();
      });
    });
  }

  it('completes the handshake with the prompt answers', async () => {
    connectTriggersKeyboardInteractive();
    const prompt = vi.fn(async () => ['123456']);
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() },
      { verify: async () => true },
      prompt
    );

    await session.connect();

    expect(prompt).toHaveBeenCalledWith({
      name: '2FA',
      instructions: '',
      prompts: [{ prompt: 'Verification code:', echo: false }]
    });
    expect(session.isConnected()).toBe(true);
  });

  it('rejects with a clear error when the user cancels the prompt', async () => {
    connectTriggersKeyboardInteractive();
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() },
      { verify: async () => true },
      async () => undefined
    );

    await expect(session.connect()).rejects.toThrow('Keyboard-interactive authentication was cancelled.');
    expect(session.isConnected()).toBe(false);
    expect(sshSessionMocks.end).toHaveBeenCalled();
    expect(sshSessionMocks.disposeHandle).toHaveBeenCalled();
  });

  it('rejects instead of hanging when no prompt is available', async () => {
    connectTriggersKeyboardInteractive();
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() },
      { verify: async () => true }
    );

    await expect(session.connect()).rejects.toThrow(
      'The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.'
    );
    expect(sshSessionMocks.end).toHaveBeenCalled();
  });
});
