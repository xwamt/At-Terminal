import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('MCP documentation', () => {
  it('documents Continue MCP setup and points at dist/mcp-server.js', () => {
    const sample = readFileSync('docs/mcp/continue-at-terminal-mcp.yaml', 'utf8');
    const readme = readFileSync('README.md', 'utf8');
    const features = readFileSync('docs/features.md', 'utf8');
    const usage = readFileSync('docs/usage.md', 'utf8');
    const chineseReadme = readFileSync('docs/README.zh-CN.md', 'utf8');
    const chineseFeatures = readFileSync('docs/features.zh-CN.md', 'utf8');
    const chineseUsage = readFileSync('docs/usage.zh-CN.md', 'utf8');

    expect(sample).toContain('mcpServers:');
    expect(sample).toContain('dist/mcp-server.js');
    expect(readme).toContain('AT Terminal MCP');
    expect(readme).toContain('[Features](docs/features.md)');
    expect(readme).toContain('[Usage Guide](docs/usage.md)');
    expect(readme).toContain('[Chinese documentation](docs/README.zh-CN.md)');
    expect(readme).toContain('skills/at-terminal-mcp/SKILL.md');
    expect(readme).toContain('| Capability | Base `AT Terminal` | `AT Terminal MCP` |');
    expect(readme).toContain('dist/mcp-server.js');
    expect(features).toContain('get_terminal_context');
    expect(features).toContain('sftp_read_file');
    expect(features).toContain('Trust agent remote commands');
    expect(features).toContain('does not bypass SFTP write authorization or SSH host key trust');
    expect(usage).toContain('AT Terminal: Install MCP Config');
    expect(usage).toContain('~/.kiro/settings/mcp.json');
    expect(usage).toContain('dist/mcp-server.js');
    expect(chineseReadme).toContain('AT Terminal MCP 中文文档');
    expect(chineseReadme).toContain('[功能介绍](features.zh-CN.md)');
    expect(chineseReadme).toContain('[使用教程](usage.zh-CN.md)');
    expect(chineseFeatures).toContain('get_terminal_context');
    expect(chineseFeatures).toContain('Trust agent remote commands');
    expect(chineseUsage).toContain('AT Terminal: Install MCP Config');
    expect(chineseUsage).toContain('~/.kiro/settings/mcp.json');
  });
});
