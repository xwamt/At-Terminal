import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('AT Terminal MCP skill', () => {
  it('documents install prerequisites, tool selection, and safety boundaries', () => {
    const skill = readFileSync('skills/at-terminal-mcp/SKILL.md', 'utf8');

    expect(skill).toContain('name: at-terminal-mcp');
    expect(skill).toContain('Use when');
    expect(skill).toContain('dist/mcp-server.js');
    expect(skill).toContain('AT Terminal: Install MCP Config');
    expect(skill).toContain('get_terminal_context');
    expect(skill).toContain('run_remote_command');
    expect(skill).toContain('sftp_read_file');
    expect(skill).toContain('sftp_write_file');
    expect(skill).toContain('non-interactive');
    expect(skill).toContain('first write authorization');
    expect(skill).toContain('If MCP is not configured');
    expect(skill).toContain('.kiro/settings/mcp.json');
    expect(skill).toContain('.cursor/mcp.json');
    expect(skill).toContain('.continue/mcpServers/at-terminal.yaml');
    expect(skill).toContain('wait for the user to approve the AT Terminal or VS Code confirmation dialog');
    expect(skill).toContain('# Purpose:');
  });
});
