import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSshConnectConfig, buildSshConnectionHandle } from '../../src/ssh/SshConnectionConfig';
import type { ServerConfig } from '../../src/config/schema';

const sshMocks = vi.hoisted(() => ({
  clients: [] as Array<{
    handlers: Record<string, (...args: never[]) => void>;
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

describe('buildSshConnectConfig', () => {
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

  it('throws a clear error when password auth has no stored password', async () => {
    await expect(
      buildSshConnectConfig(server(), { getPassword: async () => undefined })
    ).rejects.toThrow('Missing password. Edit the server configuration and enter a password.');
  });

  it('loads private key auth from disk', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('PRIVATE KEY');

    const config = await buildSshConnectConfig(
      server({ authType: 'privateKey', privateKeyPath: 'C:/keys/prod.pem' }),
      { getPassword: async () => undefined }
    );

    expect(readFile).toHaveBeenCalledWith('C:/keys/prod.pem', 'utf8');
    expect(config).toMatchObject({
      privateKey: 'PRIVATE KEY'
    });
    expect('password' in config).toBe(false);
  });

  it('throws a clear error when private key auth has no key path', async () => {
    await expect(
      buildSshConnectConfig(
        server({ authType: 'privateKey', privateKeyPath: undefined }),
        { getPassword: async () => undefined }
      )
    ).rejects.toThrow('Missing private key path.');
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
      undefined
    );

    expect(sshMocks.connect).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'bastion.example.com', username: 'ops' })
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
        }
      )
    ).rejects.toThrow('Jump host "missing-jump" was not found.');
  });
});
