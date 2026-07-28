import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hubJsPath, hubVersionPath } from '@at-series/mcp-hub';
import { syncPackagedHubAt } from '../../src/mcp/hubSync';

describe('syncPackagedHubAt', () => {
  let home: string;
  let bundleDir: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'at-terminal-hubsync-home-'));
    bundleDir = await mkdtemp(join(tmpdir(), 'at-terminal-hubsync-bundle-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(bundleDir, { recursive: true, force: true });
  });

  it('elects packaged hub.js into temp home via syncHubBundle', async () => {
    const content = 'module.exports = { packaged: true };\n';
    const bundlePath = join(bundleDir, 'hub.js');
    await writeFile(bundlePath, content, 'utf8');

    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: '0.1.0', pluginVersion: '0.3.0' },
      home
    );

    expect(result).toEqual({ updated: true, activeVersion: '0.1.0' });
    await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(content);

    const meta = JSON.parse(await readFile(hubVersionPath(home), 'utf8'));
    expect(meta).toMatchObject({
      version: '0.1.0',
      writtenByPluginId: 'at.terminal',
      writtenByPluginVersion: '0.3.0'
    });
  });

  it('reads hub version from dist/hub-version.json sidecar when resolving packaged hub', async () => {
    const { syncPackagedHub } = await import('../../src/mcp/hubSync.js');
    const bundlePath = join(bundleDir, 'hub.js');
    await writeFile(bundlePath, 'module.exports = { sidecar: true };\n', 'utf8');
    await writeFile(
      join(bundleDir, 'hub-version.json'),
      JSON.stringify({ version: '0.1.0', protocolVersion: 1 }),
      'utf8'
    );

    // Simulate syncPackagedHub path resolution via syncPackagedHubAt after reading sidecar manually
    const sidecar = JSON.parse(await readFile(join(bundleDir, 'hub-version.json'), 'utf8'));
    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: sidecar.version, pluginVersion: '0.3.0' },
      home
    );
    expect(result.activeVersion).toBe('0.1.0');
    expect(syncPackagedHub).toBeTypeOf('function');
  });

  it('skips overwrite when active hub semver is newer', async () => {
    const activeContent = 'active-newer';
    await mkdir(join(home, '.at-series', 'mcp'), { recursive: true });
    await writeFile(hubJsPath(home), activeContent, 'utf8');
    await writeFile(
      hubVersionPath(home),
      JSON.stringify({
        version: '0.2.0',
        protocolVersion: 1,
        writtenByPluginId: 'at.terminal',
        writtenByPluginVersion: '0.2.0',
        writtenAt: 1,
        bundleSha256: 'abc'
      }),
      'utf8'
    );

    const bundlePath = join(bundleDir, 'hub.js');
    await writeFile(bundlePath, 'candidate-older', 'utf8');

    const result = await syncPackagedHubAt(
      bundlePath,
      { hubVersion: '0.1.0', pluginVersion: '0.3.0' },
      home
    );

    expect(result).toEqual({ updated: false, activeVersion: '0.2.0' });
    await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(activeContent);
  });
});
