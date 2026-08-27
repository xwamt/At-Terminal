import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const baseManifest = JSON.parse(readFileSync('package.base.json', 'utf8'));
const mcpManifest = JSON.parse(readFileSync('package.mcp.json', 'utf8'));
const packageScript = readFileSync('scripts/package-variant.mjs', 'utf8');
const buildConfig = readFileSync('esbuild.config.mjs', 'utf8');
const extensionSource = readFileSync('src/extension.ts', 'utf8');
const vscodeIgnore = readFileSync('.vscodeignore', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const baseReadme = readFileSync('README-base.md', 'utf8');
const manifests = [baseManifest, mcpManifest, JSON.parse(readFileSync('package.json', 'utf8'))];

describe('package variants', () => {
  it('keeps the base manifest free of agent and MCP contributions', () => {
    expect(baseManifest.displayName).toBe('%atTerminal.displayName%');
    expect(baseManifest.activationEvents).not.toContain('onLanguageModelTool:list_ssh_servers');
    expect(JSON.stringify(baseManifest.contributes)).not.toContain('languageModelTools');
    expect(baseManifest.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
  });

  it('gives the MCP build its own display name', () => {
    expect(mcpManifest.displayName).toBe('%atTerminal.mcpDisplayName%');
    expect(baseManifest.displayName).toBe('%atTerminal.displayName%');
    expect(mcpManifest.displayName).not.toBe(baseManifest.displayName);
  });

  it('keeps the MCP manifest free of languageModelTools while retaining MCP activation', () => {
    expect(mcpManifest.displayName).toBe('%atTerminal.mcpDisplayName%');
    expect(mcpManifest.activationEvents).toContain('onStartupFinished');
    expect(mcpManifest.activationEvents.every((event: string) => !event.startsWith('onLanguageModelTool:'))).toBe(
      true
    );
    expect(mcpManifest.contributes.languageModelTools).toBeUndefined();
    expect(JSON.stringify(mcpManifest.contributes)).not.toContain('languageModelTools');
    expect(mcpManifest.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
  });

  it('keeps the MCP config command only in the MCP manifest', () => {
    expect(JSON.stringify(baseManifest.contributes)).not.toContain('sshManager.installMcpConfig');
    expect(JSON.stringify(baseManifest.contributes)).not.toContain('sshManager.uninstallAtSeriesMcpConfig');
    expect(JSON.stringify(mcpManifest.contributes.commands)).toContain('sshManager.installMcpConfig');
    expect(JSON.stringify(mcpManifest.contributes.commands)).toContain('sshManager.uninstallAtSeriesMcpConfig');
  });

  it('keeps Connect available without showing it as an inline server action', () => {
    for (const manifest of manifests) {
      expect(manifest.contributes.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: 'sshManager.connect',
            title: '%atTerminal.command.connect.title%'
          })
        ])
      );

      expect(manifest.contributes.menus['view/item/context']).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: 'sshManager.connect',
            when: 'view == sshManager.servers && viewItem == server',
            group: 'inline@1'
          })
        ])
      );
    }
  });

  it('contributes viewsWelcome for the empty Servers and SFTP Files views in every variant', () => {
    for (const manifest of manifests) {
      expect(manifest.contributes.viewsWelcome).toEqual([
        { view: 'sshManager.servers', contents: '%atTerminal.viewsWelcome.servers%' },
        { view: 'sshManager.sftpFiles', contents: '%atTerminal.viewsWelcome.sftpFiles%' }
      ]);
    }
  });

  it('categorizes every command under AT Terminal in every variant', () => {
    for (const manifest of manifests) {
      for (const command of manifest.contributes.commands) {
        expect(command.category, command.command).toBe('AT Terminal');
      }
    }
  });

  it('contributes host key commands on the server context menu in every variant', () => {
    for (const manifest of manifests) {
      const commands = manifest.contributes.commands.map((entry: { command: string }) => entry.command);
      expect(commands).toContain('sshManager.viewHostFingerprint');
      expect(commands).toContain('sshManager.forgetHostKey');
      expect(manifest.contributes.menus['view/item/context']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            command: 'sshManager.viewHostFingerprint',
            when: 'view == sshManager.servers && viewItem == server'
          }),
          expect.objectContaining({
            command: 'sshManager.forgetHostKey',
            when: 'view == sshManager.servers && viewItem == server'
          })
        ])
      );
    }
  });

  it('hides tree-item-only SFTP commands from the palette but keeps server commands available', () => {
    for (const manifest of manifests) {
      const palette = manifest.contributes.menus.commandPalette as Array<{ command: string; when: string }>;
      const hidden = palette.filter((entry) => entry.when === 'false').map((entry) => entry.command);
      expect(hidden).toEqual(
        expect.arrayContaining([
          'sshManager.sftp.download',
          'sshManager.sftp.delete',
          'sshManager.sftp.rename',
          'sshManager.sftp.edit',
          'sshManager.sftp.openPreview',
          'sshManager.sftp.cdToDirectory',
          'sshManager.sftp.copyPath'
        ])
      );
      for (const command of [
        'sshManager.connect',
        'sshManager.editServer',
        'sshManager.deleteServer',
        'sshManager.disconnect',
        'sshManager.reconnect',
        'sshManager.copyHost'
      ]) {
        expect(hidden, command).not.toContain(command);
      }
    }
  });

  it('declares the zebraStripes and sessionLogDirectory settings identically in every variant', () => {
    for (const manifest of manifests) {
      const properties = manifest.contributes.configuration.properties;
      expect(properties['sshManager.zebraStripes']).toEqual({
        type: 'boolean',
        default: false,
        description: '%atTerminal.config.zebraStripes.description%'
      });
      expect(properties['sshManager.sessionLogDirectory']).toEqual({
        type: 'string',
        default: '',
        description: '%atTerminal.config.sessionLogDirectory.description%'
      });
      for (const [key, value] of Object.entries(properties) as Array<[string, { description?: string }]>) {
        expect(value.description, key).toMatch(/^%atTerminal\.config\.[\w.]+\.description%$/);
      }
    }
  });

  it('does not build a per-plugin mcp-server entry', () => {
    expect(buildConfig).toContain('--variant=mcp');
    expect(buildConfig).not.toContain('src/mcp/server.ts');
    expect(buildConfig).not.toContain('dist/mcp-server.js');
  });

  it('guards extension MCP runtime behind a build flag', () => {
    expect(extensionSource).toContain('MCP_ENABLED');
    expect(extensionSource).toContain('if (MCP_ENABLED)');
    expect(extensionSource).not.toContain('registerAgentTools');
  });

  it('stages package variants before running vsce', () => {
    expect(packageScript).toContain('package.base.json');
    expect(packageScript).toContain('package.mcp.json');
    expect(packageScript).toContain('vsce');
  });

  it('packages the base and MCP variants with their own README files', () => {
    expect(packageScript).toContain("variant === 'base' ? 'README-base.md' : 'README.md'");
    expect(packageScript).toContain("join(root, readmeName)");
    expect(packageScript).toContain("join(stage, 'README.md')");
  });

  it('ships hub.js for MCP packaging and never requires mcp-server.js', () => {
    expect(packageScript).toContain("join(stage, 'dist', 'hub.js')");
    expect(packageScript).toContain('hub.js');
    expect(packageScript).toContain('mcp-server.js');
  });

  it('keeps packaged VSIX files lean by excluding bundled dependencies and large screenshots', () => {
    expect(packageScript).toContain('createPackagedManifest');
    expect(packageScript).toContain('prunePackagedDependencies');
    expect(packageScript).toContain('RUNTIME_DEPENDENCIES');
    expect(packageScript).toContain("'ssh2'");
    expect(packageScript).toContain("'--omit=optional'");
    expect(packageScript).toContain("join(root, 'docs', 'images')");
    expect(packageScript).toContain("join(root, 'docs', 'features.md')");
    expect(packageScript).toContain("join(root, 'docs', 'features.zh-CN.md')");
    expect(packageScript).toContain("join(root, 'docs', 'usage.zh-CN.md')");
    expect(packageScript).toContain("join(root, 'docs', 'mcp')");
    expect(packageScript).toContain('--no-rewrite-relative-links');
    expect(packageScript).not.toContain('--baseImagesUrl');
    expect(packageScript).not.toContain('https://example.com/at-terminal');
    expect(vscodeIgnore).toContain('!docs/*.md');
    expect(vscodeIgnore).toContain('!docs/mcp/*.yaml');
    expect(vscodeIgnore).toContain('node_modules/**');
    expect(vscodeIgnore).toContain('!node_modules/ssh2/**');
    expect(vscodeIgnore).not.toContain('!docs/images/*.png');
    expect(readme).not.toContain('.gif');
    expect(baseReadme).not.toContain('.gif');
  });
});
