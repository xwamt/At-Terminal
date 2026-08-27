import { describe, it, expect } from 'vitest';
import { AT_TERMINAL_TOOL_CATALOG, AT_TERMINAL_PLUGIN_ID } from '../../src/mcp/toolCatalog';

describe('toolCatalog', () => {
  it('uses stable pluginId', () => {
    expect(AT_TERMINAL_PLUGIN_ID).toBe('at.terminal');
  });

  it('declares risk for all eleven tools', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((t) => [t.name, t.risk]));
    expect(AT_TERMINAL_TOOL_CATALOG).toHaveLength(11);
    expect(byName.list_ssh_servers).toBe('read');
    expect(byName.get_terminal_context).toBe('read');
    expect(byName.sftp_list_directory).toBe('read');
    expect(byName.sftp_stat_path).toBe('read');
    expect(byName.sftp_read_file).toBe('read');
    expect(byName.sftp_write_file).toBe('write');
    expect(byName.sftp_create_file).toBe('write');
    expect(byName.sftp_create_directory).toBe('write');
    expect(byName.sftp_rename).toBe('write');
    expect(byName.sftp_delete).toBe('write');
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

  it('teaches the caller offset continuation and tail reads', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((t) => [t.name, t]));

    expect(byName.sftp_read_file.description).toContain('offset');
    expect(byName.sftp_read_file.description).toMatch(/negative/i);
    expect(byName.sftp_read_file.description).toMatch(/tail/i);
    expect(byName.sftp_read_file.description).not.toContain('read a smaller range');
    expect(byName.sftp_read_file.inputSchema.properties).toMatchObject({
      offset: expect.objectContaining({ type: 'number' })
    });

    expect(byName.sftp_list_directory.description).toContain('offset');
    expect(byName.sftp_list_directory.inputSchema.properties).toMatchObject({
      offset: expect.objectContaining({ type: 'number' })
    });
  });

  it('describes rename and delete authorization honestly', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((t) => [t.name, t]));

    expect(byName.sftp_rename.description).toContain('source and destination');
    expect(byName.sftp_rename.inputSchema.required).toEqual(['path', 'newPath']);

    expect(byName.sftp_delete.description).toContain('single remote file');
    expect(byName.sftp_delete.description).toMatch(/directories are refused/i);
    expect(byName.sftp_delete.description).toContain('even on fully trusted servers');
    expect(byName.sftp_delete.description).toContain('never remembered');
  });

  it('tells the caller that confirmation follows the three server trust levels', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((tool) => [tool.name, tool]));

    expect(byName.run_remote_command.description).toContain('untrusted');
    expect(byName.run_remote_command.description).toContain('limited trust');
    expect(byName.run_remote_command.description).toContain('full trust');
  });

  it('tells the caller that run_remote_command confirms the commands on a blocklist', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((tool) => [tool.name, tool]));

    expect(byName.run_remote_command.description).toContain('blocklist');
    expect(byName.run_remote_command.description).toContain('confirmation');
    expect(byName.run_remote_command.description).not.toContain('allowlist');
  });

  it('tells the caller that every stage of a chained command is checked', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((tool) => [tool.name, tool]));

    expect(byName.run_remote_command.description).toContain('stage');
    expect(byName.run_remote_command.description).not.toContain('no pipes');
  });

  it('admits to the caller that an unknown command is not gated', () => {
    const byName = Object.fromEntries(AT_TERMINAL_TOOL_CATALOG.map((tool) => [tool.name, tool]));

    expect(byName.run_remote_command.description).toContain('Unknown commands');
  });

  it('tells the caller that write authorization is per directory, not per server', () => {
    const writeTools = AT_TERMINAL_TOOL_CATALOG.filter((tool) => tool.risk === 'write');

    expect(writeTools).toHaveLength(5);
    for (const tool of writeTools) {
      expect(tool.description).toContain('directory');
      expect(tool.description).toContain('sensitive');
      expect(tool.description).not.toContain('per server');
    }
  });
});
