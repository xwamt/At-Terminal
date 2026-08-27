import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSshConnectConfig,
  buildSshConnectionHandle,
  requireHostKeyVerifier,
  resolveAgentSocket
} from '../../src/ssh/SshConnectionConfig';
import type { ServerConfig } from '../../src/config/schema';

const sshMocks = vi.hoisted(() => ({
  clients: [] as Array<{
    handlers: Record<string, (...args: never[]) => void>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    forwardOut: ReturnType<typeof vi.fn>;
  }>,
  connect: vi.fn(function (this: { handlers?: Record<string, () => void> }) {
    this.handlers?.ready?.();
  }),
  end: vi.fn(),
  forwardOut: vi.fn()
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn()
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
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
      connect: sshMocks.connect,
      end: sshMocks.end,
      forwardOut: sshMocks.forwardOut
    };
    sshMocks.clients.push(client);
    return client;
  })
}));

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
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
    updatedAt: 1,
    ...overrides
  };
}

beforeEach(() => {
  sshMocks.clients.length = 0;
  sshMocks.connect.mockClear();
  sshMocks.end.mockClear();
  sshMocks.forwardOut.mockReset();
  sshMocks.connect.mockImplementation(function (this: { handlers?: Record<string, () => void> }) {
    this.handlers?.ready?.();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requireHostKeyVerifier', () => {
  it('throws instead of silently accepting any host key when no verifier is supplied', () => {
    expect(() => requireHostKeyVerifier(undefined)).toThrow(
      'A host key verifier is required. Refusing to open an SSH connection that would accept any host key.'
    );
  });

  it('returns the verifier unchanged when one is supplied', () => {
    const verifier = { verify: async () => true };

    expect(requireHostKeyVerifier(verifier)).toBe(verifier);
  });
});

describe('resolveAgentSocket', () => {
  it('prefers SSH_AUTH_SOCK on every platform', () => {
    expect(resolveAgentSocket('linux', { SSH_AUTH_SOCK: '/tmp/agent.sock' })).toBe('/tmp/agent.sock');
    expect(resolveAgentSocket('win32', { SSH_AUTH_SOCK: '/tmp/agent.sock' })).toBe('/tmp/agent.sock');
  });

  it('falls back to the OpenSSH agent pipe on Windows', () => {
    expect(resolveAgentSocket('win32', {})).toBe('\\\\.\\pipe\\openssh-ssh-agent');
  });

  it('throws a clear error when no agent socket is available', () => {
    expect(() => resolveAgentSocket('linux', {})).toThrow(
      'Missing SSH agent socket. Set the SSH_AUTH_SOCK environment variable or start an SSH agent.'
    );
  });
});

describe('buildSshConnectConfig', () => {
  it('always installs a host verifier so ssh2 can never fall back to accepting any key', async () => {
    const passwordConfig = await buildSshConnectConfig(
      server(),
      { getPassword: async () => 'secret' },
      { verify: async () => true }
    );
    vi.mocked(readFile).mockResolvedValueOnce('PRIVATE KEY');
    const keyConfig = await buildSshConnectConfig(
      server({ authType: 'privateKey', privateKeyPath: 'C:/keys/prod.pem' }),
      { getPassword: async () => undefined },
      { verify: async () => true }
    );

    expect(passwordConfig.hostVerifier).toEqual(expect.any(Function));
    expect(keyConfig.hostVerifier).toEqual(expect.any(Function));
  });

  it('builds password auth config with keepalive and host verifier', async () => {
    const verifier = { verify: vi.fn(async () => true) };

    const config = await buildSshConnectConfig(
      server(),
      { getPassword: async () => 'secret' },
      verifier
    );

    expect(config).toMatchObject({
      host: 'example.com',
      port: 22,
      username: 'deploy',
      password: 'secret',
      keepaliveInterval: 30_000,
      hostHash: 'sha256'
    });
    expect(config.hostVerifier).toEqual(expect.any(Function));
  });

  it('enables keyboard-interactive so 2FA servers can prompt', async () => {
    const config = await buildSshConnectConfig(
      server(),
      { getPassword: async () => 'secret' },
      { verify: async () => true }
    );

    expect(config.tryKeyboard).toBe(true);
  });

  it('throws a clear error when password auth has no stored password', async () => {
    await expect(
      buildSshConnectConfig(server(), { getPassword: async () => undefined }, { verify: async () => true })
    ).rejects.toThrow('Missing password. Edit the server configuration and enter a password.');
  });

  it('loads private key auth from disk', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('PRIVATE KEY');

    const config = await buildSshConnectConfig(
      server({ authType: 'privateKey', privateKeyPath: 'C:/keys/prod.pem' }),
      { getPassword: async () => undefined },
      { verify: async () => true }
    );

    expect(readFile).toHaveBeenCalledWith('C:/keys/prod.pem', 'utf8');
    expect(config).toMatchObject({
      privateKey: 'PRIVATE KEY'
    });
    expect('password' in config).toBe(false);
    expect('passphrase' in config).toBe(false);
  });

  it('passes a stored passphrase through to ssh2 for encrypted keys', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('ENCRYPTED KEY');
    const getPassphrase = vi.fn(async () => 'key-passphrase');

    const config = await buildSshConnectConfig(
      server({ authType: 'privateKey', privateKeyPath: 'C:/keys/prod.pem' }),
      { getPassword: async () => undefined, getPassphrase },
      { verify: async () => true }
    );

    expect(getPassphrase).toHaveBeenCalledWith('server-1');
    expect(config).toMatchObject({
      privateKey: 'ENCRYPTED KEY',
      passphrase: 'key-passphrase'
    });
  });

  it('omits the passphrase when the provider has none stored', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('PRIVATE KEY');

    const config = await buildSshConnectConfig(
      server({ authType: 'privateKey', privateKeyPath: 'C:/keys/prod.pem' }),
      { getPassword: async () => undefined, getPassphrase: async () => undefined },
      { verify: async () => true }
    );

    expect('passphrase' in config).toBe(false);
  });

  it('throws a clear error when private key auth has no key path', async () => {
    await expect(
      buildSshConnectConfig(
        server({ authType: 'privateKey', privateKeyPath: undefined }),
        { getPassword: async () => undefined },
        { verify: async () => true }
      )
    ).rejects.toThrow('Missing private key path.');
  });

  it('points agent auth at the SSH_AUTH_SOCK socket', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock');

    const config = await buildSshConnectConfig(
      server({ authType: 'agent' }),
      { getPassword: async () => undefined },
      { verify: async () => true }
    );

    expect(config).toMatchObject({ agent: '/tmp/agent.sock' });
    expect('password' in config).toBe(false);
    expect('privateKey' in config).toBe(false);
  });

  it('waits for async host key verification callback instead of accepting synchronously', async () => {
    let resolveVerification: (value: boolean) => void = () => undefined;
    const verifier = {
      verify: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveVerification = resolve;
          })
      )
    };

    const config = await buildSshConnectConfig(
      server(),
      { getPassword: async () => 'secret' },
      verifier
    );
    const verify = vi.fn();

    const result = config.hostVerifier!('SHA256:abc' as never, verify);

    expect(result).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    resolveVerification(false);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(false));
    expect(verifier.verify).toHaveBeenCalledWith('example.com', 22, 'SHA256:abc');
  });
});

describe('buildSshConnectionHandle', () => {
  it('builds a routed target config through a direct jump host', async () => {
    const fakeSock = { readable: true };
    sshMocks.forwardOut.mockImplementationOnce((_srcIp, _srcPort, _dstHost, _dstPort, callback) => {
      callback(undefined, fakeSock);
    });

    const target = server({ id: 'target-1', host: '10.0.0.20', jumpHostId: 'jump-1' });
    const jump = server({ id: 'jump-1', host: 'bastion.example.com', username: 'ops', jumpHostId: 'ignored-parent' });

    const handle = await buildSshConnectionHandle(
      target,
      {
        getPassword: async () => 'secret',
        getServer: async (id) => (id === 'jump-1' ? jump : undefined)
      },
      { verify: async () => true }
    );

    expect(sshMocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'bastion.example.com', username: 'ops' })
    );
    expect(sshMocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ hostVerifier: expect.any(Function) })
    );
    expect(sshMocks.forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, '10.0.0.20', 22, expect.any(Function));
    expect(handle.config).toMatchObject({ host: '10.0.0.20', sock: fakeSock });

    handle.dispose();

    expect(sshMocks.end).toHaveBeenCalled();
  });

  it('throws a clear error when the jump host does not exist', async () => {
    await expect(
      buildSshConnectionHandle(
        server({ jumpHostId: 'missing-jump' }),
        {
          getPassword: async () => 'secret',
          getServer: async () => undefined
        },
        { verify: async () => true }
      )
    ).rejects.toThrow('Jump host "missing-jump" was not found.');
  });

  it('answers a jump host keyboard-interactive round through the injected prompt', async () => {
    const fakeSock = { readable: true };
    sshMocks.forwardOut.mockImplementationOnce((_srcIp, _srcPort, _dstHost, _dstPort, callback) => {
      callback(undefined, fakeSock);
    });
    const finished: string[][] = [];
    sshMocks.connect.mockImplementationOnce(function (this: {
      handlers: Record<string, (...args: never[]) => void>;
    }) {
      const handler = this.handlers['keyboard-interactive'] as unknown as (
        name: string,
        instructions: string,
        lang: string,
        prompts: Array<{ prompt: string; echo?: boolean }>,
        finish: (responses: string[]) => void
      ) => void;
      handler('2FA', '', '', [{ prompt: 'Verification code:', echo: false }], (responses) => {
        finished.push(responses);
        this.handlers.ready();
      });
    });

    const target = server({ id: 'target-1', host: '10.0.0.20', jumpHostId: 'jump-1' });
    const jump = server({ id: 'jump-1', host: 'bastion.example.com' });
    const prompt = vi.fn(async () => ['123456']);

    const handle = await buildSshConnectionHandle(
      target,
      {
        getPassword: async () => 'secret',
        getServer: async (id) => (id === 'jump-1' ? jump : undefined)
      },
      { verify: async () => true },
      { keyboardInteractivePrompt: prompt }
    );

    expect(prompt).toHaveBeenCalledWith({
      name: '2FA',
      instructions: '',
      prompts: [{ prompt: 'Verification code:', echo: false }]
    });
    expect(finished).toEqual([['123456']]);
    expect(handle.config).toMatchObject({ host: '10.0.0.20', sock: fakeSock });
  });

  it('rejects a jump host keyboard-interactive request instead of hanging when no prompt exists', async () => {
    sshMocks.connect.mockImplementationOnce(function (this: {
      handlers: Record<string, (...args: never[]) => void>;
    }) {
      const handler = this.handlers['keyboard-interactive'] as unknown as (
        name: string,
        instructions: string,
        lang: string,
        prompts: Array<{ prompt: string; echo?: boolean }>,
        finish: (responses: string[]) => void
      ) => void;
      handler('2FA', '', '', [{ prompt: 'Verification code:', echo: false }], () => undefined);
    });

    const target = server({ id: 'target-1', host: '10.0.0.20', jumpHostId: 'jump-1' });
    const jump = server({ id: 'jump-1', host: 'bastion.example.com' });

    await expect(
      buildSshConnectionHandle(
        target,
        {
          getPassword: async () => 'secret',
          getServer: async (id) => (id === 'jump-1' ? jump : undefined)
        },
        { verify: async () => true }
      )
    ).rejects.toThrow(
      'The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.'
    );
    expect(sshMocks.end).toHaveBeenCalled();
  });
});
