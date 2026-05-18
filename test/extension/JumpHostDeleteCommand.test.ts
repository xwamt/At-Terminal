import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';
import { formatJumpHostDeleteBlockMessage } from '../../src/extension';

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
});
