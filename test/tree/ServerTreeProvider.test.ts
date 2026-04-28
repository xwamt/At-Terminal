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
});
