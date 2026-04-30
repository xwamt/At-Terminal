import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MCP documentation', () => {
  it('documents Continue MCP setup and points at dist/mcp-server.js', () => {
    const sample = readFileSync('docs/mcp/continue-at-terminal-mcp.yaml', 'utf8');
    const readme = readFileSync('README.md', 'utf8');

    expect(sample).toContain('mcpServers:');
    expect(sample).toContain('dist/mcp-server.js');
    expect(readme).toContain('AT Terminal MCP');
    expect(readme).toContain('dist/mcp-server.js');
  });
});
