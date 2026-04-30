import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MCP server tool registrations', () => {
  it('registers terminal context tool', () => {
    const source = readFileSync('src/mcp/server.ts', 'utf8');

    expect(source).toContain("'get_terminal_context'");
    expect(source).toContain('bridge.getTerminalContext()');
  });

  it('registers first-batch sftp tools', () => {
    const source = readFileSync('src/mcp/server.ts', 'utf8');

    for (const tool of [
      'sftp_list_directory',
      'sftp_stat_path',
      'sftp_read_file',
      'sftp_write_file',
      'sftp_create_file',
      'sftp_create_directory'
    ]) {
      expect(source).toContain(`'${tool}'`);
    }
  });
});
