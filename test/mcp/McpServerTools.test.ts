import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MCP server tool registrations', () => {
  it('registers terminal context tool', () => {
    const source = readFileSync('src/mcp/server.ts', 'utf8');

    expect(source).toContain("'get_terminal_context'");
    expect(source).toContain('bridge.getTerminalContext()');
  });
});
