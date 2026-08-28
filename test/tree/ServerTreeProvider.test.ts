import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
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
  it('marks group nodes with the group context value used by package menus', () => {
    const item = new GroupTreeItem('prod');

    expect(item.groupName).toBe('prod');
    expect(item.contextValue).toBe('group');
  });

  it('groups servers and puts ungrouped servers in Default', async () => {
    const provider = new ServerTreeProvider({
      listServers: async () => [server('a', 'A', 'prod'), server('b', 'B'), server('c', 'C', 'prod')]
    });

    const roots = (await provider.getChildren()) as GroupTreeItem[];
    expect(roots.map((item) => item.groupName)).toEqual(['Default', 'prod']);

    const prodChildren = (await provider.getChildren(roots[1])) as ServerTreeItem[];
    expect(prodChildren.map((item) => item.server.label)).toEqual(['A', 'C']);
  });

  it('expands a lone Default group so imported servers are visible right away', async () => {
    const provider = new ServerTreeProvider({
      listServers: async () => [server('a', 'A'), server('b', 'B')]
    });

    const roots = (await provider.getChildren()) as GroupTreeItem[];

    expect(roots.map((item) => item.groupName)).toEqual(['Default']);
    expect(roots[0].collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it('keeps multiple groups collapsed', async () => {
    const provider = new ServerTreeProvider({
      listServers: async () => [server('a', 'A', 'prod'), server('b', 'B', 'staging')]
    });

    const roots = (await provider.getChildren()) as GroupTreeItem[];

    expect(roots).toHaveLength(2);
    for (const root of roots) {
      expect(root.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    }
  });

  it('returns an empty list instead of killing the view when listServers throws', async () => {
    const provider = new ServerTreeProvider({
      listServers: async () => {
        throw new Error('globalState unavailable');
      }
    });

    await expect(provider.getChildren()).resolves.toEqual([]);
  });

  it('resolves parents for reveal: servers point at their group, groups are roots', async () => {
    const provider = new ServerTreeProvider({
      listServers: async () => [server('a', 'A', 'prod')]
    });

    const roots = (await provider.getChildren()) as GroupTreeItem[];
    const children = (await provider.getChildren(roots[0])) as ServerTreeItem[];

    expect(provider.getParent(roots[0])).toBeUndefined();
    expect(provider.getParent(children[0])?.groupName).toBe('prod');
  });

  it('marks connected servers with the active icon and a Connected description suffix', () => {
    const item = new ServerTreeItem(server('a', 'A', 'prod'), 'connected');

    expect(item.iconPath).toEqual(expect.objectContaining({ id: 'vm-active' }));
    expect(item.description).toBe('deploy@a.example.com:22 · Connected');
  });

  it('marks servers with only disconnected terminals with the disconnect icon', () => {
    const item = new ServerTreeItem(server('a', 'A', 'prod'), 'disconnected');

    expect(item.iconPath).toEqual(expect.objectContaining({ id: 'debug-disconnect' }));
    expect(item.description).toBe('deploy@a.example.com:22');
  });

  it('reads connection states from the provider callback when building server items', async () => {
    const provider = new ServerTreeProvider(
      { listServers: async () => [server('a', 'A', 'prod'), server('b', 'B', 'prod')] },
      () => new Map([['a', 'connected' as const]])
    );

    const roots = (await provider.getChildren()) as GroupTreeItem[];
    const children = (await provider.getChildren(roots[0])) as ServerTreeItem[];

    expect(children[0].iconPath).toEqual(expect.objectContaining({ id: 'vm-active' }));
    expect(children[0].description).toContain('Connected');
    expect(children[1].iconPath).toEqual(expect.objectContaining({ id: 'server' }));
    expect(children[1].description).not.toContain('Connected');
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
