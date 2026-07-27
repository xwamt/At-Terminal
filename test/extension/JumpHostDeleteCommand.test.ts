import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';
import { deleteServerAndTrust, formatJumpHostDeleteBlockMessage } from '../../src/extension';

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

describe('jump host delete blocking', () => {
  it('formats a clear message listing dependent assets', () => {
    expect(
      formatJumpHostDeleteBlockMessage(server({ id: 'jump-1', label: 'Bastion' }), [
        server({ id: 'app-1', label: 'App One' }),
        server({ id: 'app-2', label: 'App Two' })
      ])
    ).toBe('Cannot delete "Bastion" because it is used as a jump host by: App One, App Two');
  });

  it('removes the server and its trusted host key together', async () => {
    const deletedServers: string[] = [];
    const forgottenHosts: string[] = [];

    await deleteServerAndTrust.remove(server({ id: 'server-1', host: '10.0.0.5', port: 2222 }), {
      configManager: {
        async deleteServer(id: string): Promise<void> {
          deletedServers.push(id);
        }
      },
      hostKeyStore: {
        async forget(host: string, port: number): Promise<void> {
          forgottenHosts.push(`${host}:${port}`);
        }
      }
    });

    expect(deletedServers).toEqual(['server-1']);
    expect(forgottenHosts).toEqual(['10.0.0.5:2222']);
  });
});
