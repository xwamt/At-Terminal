import { describe, expect, it } from 'vitest';
import { ServerTreeProvider } from '../../src/tree/ServerTreeProvider';
import { GroupTreeItem, ServerTreeItem } from '../../src/tree/TreeItems';
import type { ServerConfig } from '../../src/config/schema';

function server(id: string, label: string, group?: string): ServerConfig {
  return {
    id,
    label,
    group,
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

describe('ServerTreeProvider', () => {
  it('groups servers and puts ungrouped servers in Default', async () => {
    const provider = new ServerTreeProvider({
      listServers: async () => [server('a', 'A', 'prod'), server('b', 'B'), server('c', 'C', 'prod')]
    });

    const roots = (await provider.getChildren()) as GroupTreeItem[];
    expect(roots.map((item) => item.groupName)).toEqual(['Default', 'prod']);

    const prodChildren = (await provider.getChildren(roots[1])) as ServerTreeItem[];
    expect(prodChildren.map((item) => item.server.label)).toEqual(['A', 'C']);
  });

  it('shows non-sensitive server metadata in server tree items', () => {
    const item = new ServerTreeItem({
      id: 'server-1',
      label: 'Production',
      group: 'prod',
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      authType: 'privateKey',
      privateKeyPath: 'C:\\Users\\alan\\.ssh\\id_ed25519',
      keepAliveInterval: 45,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(item.description).toBe('deploy@example.com:2222');
    expect(item.iconPath).toEqual(expect.objectContaining({ id: 'server' }));
    expect(String(item.tooltip)).toContain('Production');
    expect(String(item.tooltip)).toContain('Group: prod');
    expect(String(item.tooltip)).toContain('Host: example.com');
    expect(String(item.tooltip)).toContain('Port: 2222');
    expect(String(item.tooltip)).toContain('Username: deploy');
    expect(String(item.tooltip)).toContain('Authentication: Private Key');
    expect(String(item.tooltip)).toContain('Keepalive: 45s');
    expect(String(item.tooltip)).not.toContain('id_ed25519');
  });
});
