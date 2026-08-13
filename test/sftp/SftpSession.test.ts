import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as sftpSessionModule from '../../src/sftp/SftpSession';
import { SftpSession } from '../../src/sftp/SftpSession';
import type { ServerConfig } from '../../src/config/schema';

const sshMocks = vi.hoisted(() => ({
  end: vi.fn(),
  connect: vi.fn(function (this: { handlers?: Record<string, () => void> }) {
    this.handlers?.ready?.();
  }),
  forwardOut: vi.fn((_srcIp, _srcPort, _dstHost, _dstPort, callback) => callback(undefined, { readable: true }))
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const client = {
      handlers: {} as Record<string, () => void>,
      once: vi.fn((event: string, handler: () => void) => {
        client.handlers[event] = handler;
        return client;
      }),
      connect: sshMocks.connect,
      end: sshMocks.end,
      forwardOut: sshMocks.forwardOut,
      sftp: vi.fn((callback) => callback(undefined, { realpath: vi.fn() })),
      exec: vi.fn()
    };
    return client;
  })
}));

function server(authType: 'password' | 'privateKey'): ServerConfig {
  return {
    id: 'srv',
    label: 'Server',
    host: 'example.com',
    port: 2222,
    username: 'deploy',
    authType,
    privateKeyPath: authType === 'privateKey' ? 'C:/keys/id_rsa' : undefined,
    keepAliveInterval: 15,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

const hostKeyVerifier = { verify: async () => true };

function passwordSession(): SftpSession {
  return new SftpSession(server('password'), { getPassword: async () => 'secret' }, hostKeyVerifier, {
    allowSudoFallback: true
  });
}

function agentSession(): SftpSession {
  return new SftpSession(server('password'), { getPassword: async () => 'secret' }, hostKeyVerifier, {
    allowSudoFallback: false
  });
}

beforeEach(() => {
  sshMocks.end.mockClear();
  sshMocks.connect.mockClear();
  sshMocks.forwardOut.mockClear();
});

describe('SftpSession module surface', () => {
  it('exports no connect-config builder that bypasses host key verification', () => {
    expect(Object.keys(sftpSessionModule)).not.toContain('buildSftpConnectConfig');
  });
});

describe('SftpSession jump host lifecycle', () => {
  it('disposes both target and jump host clients', async () => {
    const target = {
      ...server('password'),
      id: 'target-1',
      jumpHostId: 'jump-1'
    };
    const jump = {
      ...server('password'),
      id: 'jump-1',
      host: 'bastion.example.com'
    };
    const session = new SftpSession(
      target,
      {
        getPassword: async () => 'secret',
        getServer: async (id: string) => (id === 'jump-1' ? jump : undefined)
      } as never,
      hostKeyVerifier,
      { allowSudoFallback: true }
    );

    await session.connect();
    session.dispose();

    expect(sshMocks.forwardOut).toHaveBeenCalledWith('127.0.0.1', 0, 'example.com', 2222, expect.any(Function));
    expect(sshMocks.end).toHaveBeenCalledTimes(2);
  });
});

describe('SftpSession uploadFile sudo fallback', () => {
  it('uploads to /tmp and uses sudo when direct upload is permission denied', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const fastPut = vi
      .fn()
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback(permissionDenied))
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    let sudoCommand = '';
    const client = {
      exec: vi.fn((command: string, callback) => {
        sudoCommand = command;
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => stream.emit('close', 0));
      })
    };
    const session = passwordSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { fastPut, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await session.uploadFile('C:/tmp/app.conf', '/etc/app.conf');

    expect(fastPut).toHaveBeenCalledTimes(2);
    expect(fastPut.mock.calls[0][1]).toBe('/etc/app.conf');
    expect(fastPut.mock.calls[1][1]).toMatch(/^\/tmp\/at-terminal-upload-.+-app\.conf$/);
    expect(sudoCommand).toContain('sudo -n sh -c');
    expect(sudoCommand).toContain('/etc/app.conf');
    expect(sudoCommand).toContain(fastPut.mock.calls[1][1]);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('reports sudo fallback stderr when elevated upload also fails', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const fastPut = vi
      .fn()
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback(permissionDenied))
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    const client = {
      exec: vi.fn((_command: string, callback) => {
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => {
          stream.stderr.emit('data', Buffer.from('sudo: a password is required\n'));
          stream.emit('close', 1);
        });
      })
    };
    const session = passwordSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { fastPut, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await expect(session.uploadFile('C:/tmp/app.conf', '/etc/app.conf')).rejects.toThrow(
      'sudo: a password is required'
    );
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/at-terminal-upload-.+-app\.conf$/), expect.any(Function));
  });
});

describe('SftpSession writeFile sudo fallback', () => {
  it('reports when the direct write open never completes', async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const write = vi.fn();
    const close = vi.fn();
    const unlink = vi.fn((_remotePath, callback) => callback());
    const session = passwordSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };

    try {
      const writePromise = session
        .writeFile('/root/README-base.md', Buffer.from('hello', 'utf8'))
        .then(
          () => 'resolved',
          (error: Error) => error.message
        );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(55_000);

      await expect(Promise.race([writePromise, Promise.resolve('pending')])).resolves.toContain(
        'SFTP open timed out after 55000ms while writing /root/README-base.md'
      );
      expect(write).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the write timeout when cleanup close also never completes', async () => {
    vi.useFakeTimers();
    const handle = Buffer.from('handle');
    const open = vi.fn((_remotePath, _flags, callback) => callback(undefined, handle));
    const write = vi.fn();
    const close = vi.fn();
    const unlink = vi.fn((_remotePath, callback) => callback());
    const session = passwordSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };

    try {
      const writePromise = session
        .writeFile('/root/README-base.md', Buffer.from('hello', 'utf8'))
        .then(
          () => 'resolved',
          (error: Error) => error.message
        );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(55_000);

      await expect(Promise.race([writePromise, Promise.resolve('pending')])).resolves.toContain(
        'SFTP write timed out after 55000ms while writing /root/README-base.md at offset 0'
      );
      expect(close).toHaveBeenCalledWith(handle, expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes to /tmp and uses sudo when direct write is permission denied', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const tempHandle = Buffer.from('temp-handle');
    const open = vi
      .fn()
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(permissionDenied))
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(undefined, tempHandle));
    const write = vi.fn((_handle, _buffer, _offset, length, _position, callback) => callback(undefined, length));
    const close = vi.fn((_handle, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    let sudoCommand = '';
    const client = {
      exec: vi.fn((command: string, callback) => {
        sudoCommand = command;
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => stream.emit('close', 0));
      })
    };
    const session = passwordSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await session.writeFile('/root/README-base.md', Buffer.from('hello', 'utf8'));

    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[0][0]).toBe('/root/README-base.md');
    expect(open.mock.calls[1][0]).toMatch(/^\/tmp\/at-terminal-write-.+-README-base\.md$/);
    expect(write).toHaveBeenCalledWith(tempHandle, Buffer.from('hello', 'utf8'), 0, 5, 0, expect.any(Function));
    expect(close).toHaveBeenCalledWith(tempHandle, expect.any(Function));
    expect(sudoCommand).toContain('sudo -n sh -c');
    expect(sudoCommand).toContain('/root/README-base.md');
    expect(sudoCommand).toContain(open.mock.calls[1][0]);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('reports sudo stderr when elevated write also fails', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const tempHandle = Buffer.from('temp-handle');
    const open = vi
      .fn()
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(permissionDenied))
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(undefined, tempHandle));
    const write = vi.fn((_handle, _buffer, _offset, length, _position, callback) => callback(undefined, length));
    const close = vi.fn((_handle, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    const client = {
      exec: vi.fn((_command: string, callback) => {
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => {
          stream.stderr.emit('data', Buffer.from('sudo: a password is required\n'));
          stream.emit('close', 1);
        });
      })
    };
    const session = passwordSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await expect(session.writeFile('/root/README-base.md', Buffer.from('hello', 'utf8'))).rejects.toThrow(
      'sudo: a password is required'
    );
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/at-terminal-write-.+-README-base\.md$/), expect.any(Function));
  });

  it('reports when the elevated write never completes', async () => {
    vi.useFakeTimers();
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const tempHandle = Buffer.from('temp-handle');
    const open = vi
      .fn()
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(permissionDenied))
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(undefined, tempHandle));
    const write = vi.fn((_handle, _buffer, _offset, length, _position, callback) => callback(undefined, length));
    const close = vi.fn((_handle, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    const client = {
      exec: vi.fn((_command: string, callback) => {
        callback(undefined, new FakeExecStream());
      })
    };
    const session = passwordSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    try {
      const writePromise = session
        .writeFile('/root/README-base.md', Buffer.from('hello', 'utf8'))
        .then(
          () => 'resolved',
          (error: Error) => error.message
        );
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(55_000);

      await expect(Promise.race([writePromise, Promise.resolve('pending')])).resolves.toContain(
        'SFTP sudo fallback timed out after 55000ms while writing /root/README-base.md'
      );
      expect(unlink).toHaveBeenCalledWith(
        expect.stringMatching(/^\/tmp\/at-terminal-write-.+-README-base\.md$/),
        expect.any(Function)
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SftpSession with sudo fallback disabled', () => {
  it('surfaces the permission error instead of escalating a denied write', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const open = vi.fn((_remotePath, _flags, callback) => callback(permissionDenied));
    const write = vi.fn();
    const close = vi.fn();
    const unlink = vi.fn((_remotePath, callback) => callback());
    const exec = vi.fn();
    const session = agentSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = { exec };

    await expect(session.writeFile('/etc/cron.d/task', Buffer.from('hello', 'utf8'))).rejects.toThrow(
      'Privilege escalation is disabled for agent SFTP sessions.'
    );
    expect(exec).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('surfaces the permission error instead of escalating a denied upload', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const fastPut = vi.fn((_localPath, _remotePath, _options, callback) => callback(permissionDenied));
    const unlink = vi.fn((_remotePath, callback) => callback());
    const exec = vi.fn();
    const session = agentSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { fastPut, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = { exec };

    await expect(session.uploadFile('C:/tmp/app.conf', '/etc/app.conf')).rejects.toThrow(
      'Privilege escalation is disabled for agent SFTP sessions.'
    );
    expect(exec).not.toHaveBeenCalled();
    expect(fastPut).toHaveBeenCalledTimes(1);
  });

  it('never writes the payload to /tmp when escalation is off', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const open = vi.fn((_remotePath, _flags, callback) => callback(permissionDenied));
    const session = agentSession();
    (session as unknown as { sftp: unknown }).sftp = {
      open,
      write: vi.fn(),
      close: vi.fn(),
      unlink: vi.fn((_remotePath, callback) => callback())
    };

    await expect(
      session.writeFile('/etc/cron.d/task', Buffer.from('hello', 'utf8'))
    ).rejects.toThrow();
    expect(open.mock.calls.map((call) => call[0])).toEqual(['/etc/cron.d/task']);
  });
});

describe('SftpSession createFile sudo fallback', () => {
  it('creates an empty protected file through the sudo write fallback', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const tempHandle = Buffer.from('temp-handle');
    const open = vi
      .fn()
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(permissionDenied))
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(permissionDenied))
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(undefined, tempHandle));
    const write = vi.fn((_handle, _buffer, _offset, length, _position, callback) => callback(undefined, length));
    const close = vi.fn((_handle, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    let sudoCommand = '';
    const client = {
      exec: vi.fn((command: string, callback) => {
        sudoCommand = command;
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => stream.emit('close', 0));
      })
    };
    const session = passwordSession();
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await session.createFile('/root/empty.txt');

    expect(open.mock.calls[0][0]).toBe('/root/empty.txt');
    expect(open.mock.calls[0][1]).toBe('wx');
    expect(open.mock.calls[1][0]).toBe('/root/empty.txt');
    expect(open.mock.calls[1][1]).toBe('w');
    expect(open.mock.calls[2][0]).toMatch(/^\/tmp\/at-terminal-write-.+-empty\.txt$/);
    expect(write).not.toHaveBeenCalled();
    expect(sudoCommand).toContain('/root/empty.txt');
    expect(sudoCommand).toContain(open.mock.calls[2][0]);
  });
});

class FakeExecStream extends EventEmitter {
  readonly stderr = new EventEmitter();
}
