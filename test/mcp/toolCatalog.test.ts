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
});
