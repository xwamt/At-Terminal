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

describe('SshSession host key verification', () => {
  it('tracks connection state as disconnected before connect and after dispose', () => {
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() }
    );

    expect(session.isConnected()).toBe(false);
    session.dispose();
    expect(session.isConnected()).toBe(false);
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
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() },
      verifier
    );

    const config = await (session as unknown as { buildConnectConfig(): Promise<{ hostVerifier: Function }> }).buildConnectConfig();
    const verify = vi.fn();

    const result = config.hostVerifier('SHA256:abc', verify);

    expect(result).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    resolveVerification(false);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(false));
  });
});
