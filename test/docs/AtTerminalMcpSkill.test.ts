import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AT Terminal MCP skill', () => {
  const opsReferences: Record<string, string[]> = {
    'linux-host': ['load average', 'OOM', 'process'],
    'systemd-services': ['systemctl', 'journalctl', 'StartLimit'],
    'network-dns-tls': ['DNS', 'TLS', 'route'],
    'storage-filesystem': ['inode', 'mount', 'filesystem'],
    'docker-compose': ['Docker', 'Compose', 'container'],
    kubernetes: ['Pod', 'Service', 'PVC'],
    'web-proxy': ['Nginx', 'upstream', 'proxy'],
    databases: ['connection', 'lock', 'replication'],
    observability: ['metrics', 'logs', 'traces'],
    'deployment-rollbacks': ['deployment', 'canary', 'rollback'],
    'backup-disaster-recovery': ['RPO', 'RTO', 'restore'],
    'security-incidents': ['preserve evidence', 'containment', 'credentials']
  };

  it('is a concise progressive-disclosure router', () => {
    const skill = readFileSync('skills/at-terminal-mcp/SKILL.md', 'utf8');

    expect(skill).toContain('name: at-terminal-mcp');
    expect(skill).toContain('Use when');
    expect(skill).toContain('get_terminal_context');
    expect(skill).toContain('run_remote_command');
    expect(skill).toContain('non-interactive');
    expect(skill).toContain('# Purpose:');
    expect(skill).toContain('truncated');
    expect(skill).toContain('maxEntries');
    expect(skill).toContain('nginx -T');
    expect(skill).toContain('[MCP setup](references/setup.md)');
    expect(skill).toContain('[Safe operations](references/safe-operations.md)');
    expect(skill).toContain('[Workspace troubleshooting](references/workspace-troubleshooting.md)');
    expect(skill).toContain('[Incident response](references/incident-response.md)');
    expect(skill).not.toContain('Load every reference that applies');
    expect(skill).toMatch(/at most 1 ops reference/i);
    expect(skill.split(/\s+/).length).toBeLessThan(400);
  });

  it('keeps YAML description free of Hub workflow shortcut', () => {
    const skill = readFileSync('skills/at-terminal-mcp/SKILL.md', 'utf8');
    const match = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/discover\s*→\s*select/i);
    expect(match![1]).not.toMatch(/first-class call/i);
  });

  it('ships installable, one-level reference files for cross-agent use', () => {
    for (const name of [
      'setup',
      'safe-operations',
      'workspace-troubleshooting',
      'incident-response',
      ...Object.keys(opsReferences)
    ]) {
      expect(existsSync(`skills/at-terminal-mcp/references/${name}.md`)).toBe(true);
    }

    const metadata = readFileSync('skills/at-terminal-mcp/agents/openai.yaml', 'utf8');
    expect(metadata).toContain('$at-terminal-mcp');
  });

  it('keeps setup details out of the common path', () => {
    const skill = readFileSync('skills/at-terminal-mcp/SKILL.md', 'utf8');
    const setup = readFileSync('skills/at-terminal-mcp/references/setup.md', 'utf8');

    expect(skill).not.toContain('.kiro/settings/mcp.json');
    expect(skill).not.toContain('.cursor/mcp.json');
    expect(skill).not.toContain('.continue/mcpServers/at-terminal.yaml');
    expect(setup).toContain('.at-series/mcp/hub.js');
    expect(setup).toContain('AT Series');
    expect(setup).not.toContain('dist/mcp-server.js');
    expect(setup).toContain('AT Terminal: Install MCP Config');
    expect(setup).toContain('.kiro/settings/mcp.json');
    expect(setup).toContain('.cursor/mcp.json');
    expect(setup).toContain('.continue/mcpServers/at-terminal.yaml');
  });

  it('requires explicit approval and a verified backup before risky changes', () => {
    const operations = readFileSync('skills/at-terminal-mcp/references/safe-operations.md', 'utf8');

    expect(operations).toContain('explicit approval in the conversation');
    expect(operations).toContain('impact');
    expect(operations).toContain('backup');
    expect(operations).toContain('rollback');
    expect(operations).toContain('An AT Terminal or IDE confirmation dialog does not replace');
    expect(operations).toContain('Verify the backup');
  });

  it('routes joint workspace and remote-service diagnosis to dedicated guidance', () => {
    const troubleshooting = readFileSync(
      'skills/at-terminal-mcp/references/workspace-troubleshooting.md',
      'utf8'
    );

    expect(troubleshooting).toContain('workspace');
    expect(troubleshooting).toContain('remote');
    expect(troubleshooting).toContain('Do not assume');
    expect(troubleshooting).toContain('commit');
    expect(troubleshooting).toContain('checksum');
  });

  it('routes common operations domains without loading their runbooks eagerly', () => {
    const skill = readFileSync('skills/at-terminal-mcp/SKILL.md', 'utf8');

    for (const name of Object.keys(opsReferences)) {
      expect(skill).toContain(`references/${name}.md`);
    }
    expect(skill.split(/\s+/).length).toBeLessThan(600);
  });

  it('provides decision-oriented runbooks for common operations domains', () => {
    for (const [name, signals] of Object.entries(opsReferences)) {
      const reference = readFileSync(`skills/at-terminal-mcp/references/${name}.md`, 'utf8');

      expect(reference).toContain('Read this reference');
      expect(reference).toContain('read-only');
      expect(reference).toContain('Decision path');
      expect(reference).toContain('[safe operations](safe-operations.md)');
      for (const signal of signals) {
        expect(reference).toContain(signal);
      }
    }
  });
});
