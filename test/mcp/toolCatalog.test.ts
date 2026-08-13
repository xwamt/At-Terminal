import { describe, it, expect } from 'vitest';
import { AT_TERMINAL_TOOL_CATALOG, AT_TERMINAL_PLUGIN_ID } from '../../src/mcp/toolCatalog';

describe('toolCatalog', () => {
  it('uses stable pluginId', () => {
    expect(AT_TERMINAL_PLUGIN_ID).toBe('at.terminal');
  });

  it('declares risk for all nine tools', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((t) => [t.name, t.risk]));
    expect(byName.list_ssh_servers).toBe('read');
    expect(byName.get_terminal_context).toBe('read');
    expect(byName.sftp_list_directory).toBe('read');
    expect(byName.sftp_stat_path).toBe('read');
    expect(byName.sftp_read_file).toBe('read');
    expect(byName.sftp_write_file).toBe('write');
    expect(byName.sftp_create_file).toBe('write');
    expect(byName.sftp_create_directory).toBe('write');
    expect(byName.run_remote_command).toBe('exec');
  });

  it('documents payload caps for list, read, and command tools', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((t) => [t.name, t]));

    expect(byName.sftp_list_directory.description).toContain('maxEntries');
    expect(byName.sftp_list_directory.description).toContain('500');
    expect(byName.sftp_list_directory.description).toContain('truncated');
    expect(byName.sftp_list_directory.inputSchema.properties).toMatchObject({
      maxEntries: expect.objectContaining({ type: 'number' })
    });

    expect(byName.sftp_read_file.description).toMatch(/65536|64KiB|64\s*\*?\s*1024|64KB/i);
    expect(byName.sftp_read_file.description).toMatch(/262144|256KiB|256KB/i);
    expect(byName.sftp_read_file.description).toContain('truncated');

    expect(byName.run_remote_command.description).toContain('64000');
    expect(byName.run_remote_command.description).toContain('256000');
    expect(byName.run_remote_command.description).toContain('truncated');
  });

  it('tells the caller that run_remote_command only skips confirmation for read-only commands', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((tool) => [tool.name, tool]));

    expect(byName.run_remote_command.description).toContain('read-only');
    expect(byName.run_remote_command.description).toContain('confirmation');
  });
});
