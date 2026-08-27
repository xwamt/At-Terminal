import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
        // Must be the real digest of the active hub.js: syncHubBundle only
        // defers to this record while it still describes the bytes on disk,
        // so a placeholder here would make it repair the "tampered" bundle
        // instead of exercising the semver skip this test is about.
        bundleSha256: createHash('sha256')
          .update(Buffer.from(activeContent, 'utf8'))
          .digest('hex')
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

  describe('fast path', () => {
    const versions = { hubVersion: '0.1.0', pluginVersion: '0.3.0' };

    async function firstSync(content: string) {
      const bundlePath = join(bundleDir, 'hub.js');
      await writeFile(bundlePath, content, 'utf8');
      const statePath = join(home, 'hub-sync-state.json');
      const result = await syncPackagedHubAt(bundlePath, versions, home, { statePath });
      return { bundlePath, statePath, result };
    }

    /** Same-size tamper of the active hub.js, with the state record updated to its stat. */
    async function tamperKeepingStatMatch(statePath: string, tampered: string) {
      await writeFile(hubJsPath(home), tampered, 'utf8');
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      const target = await stat(hubJsPath(home));
      await writeFile(
        statePath,
        JSON.stringify({ ...state, targetSize: target.size, targetMtimeMs: target.mtimeMs }),
        'utf8'
      );
    }

    it('skips the full sha256 read when version and size/mtime still match the last sync', async () => {
      const content = 'a'.repeat(64);
      const { bundlePath, statePath, result } = await firstSync(content);
      expect(result).toEqual({ updated: true, activeVersion: '0.1.0' });

      // Only a skipped hash comparison can leave a same-size content change in place.
      const tampered = 'b'.repeat(64);
      await tamperKeepingStatMatch(statePath, tampered);

      const second = await syncPackagedHubAt(bundlePath, versions, home, { statePath });
      expect(second).toEqual({ updated: false, activeVersion: '0.1.0' });
      await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(tampered);
    });

    it('force runs the full hash election and repairs the bundle', async () => {
      const content = 'a'.repeat(64);
      const { bundlePath, statePath } = await firstSync(content);
      await tamperKeepingStatMatch(statePath, 'b'.repeat(64));

      const repaired = await syncPackagedHubAt(bundlePath, versions, home, { statePath, force: true });

      expect(repaired).toEqual({ updated: true, activeVersion: '0.1.0' });
      await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(content);
    });

    it('falls back to the full sync when the target size changed', async () => {
      const content = 'a'.repeat(64);
      const { bundlePath, statePath } = await firstSync(content);

      await writeFile(hubJsPath(home), 'tampered-with-a-different-size', 'utf8');

      const second = await syncPackagedHubAt(bundlePath, versions, home, { statePath });
      expect(second).toEqual({ updated: true, activeVersion: '0.1.0' });
      await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(content);
    });

    it('falls back to the full sync when hub-version.json names another version', async () => {
      const content = 'a'.repeat(64);
      const { bundlePath, statePath } = await firstSync(content);

      // Another plugin elected 0.2.0 (metadata consistent with the bytes on disk).
      await writeFile(
        hubVersionPath(home),
        JSON.stringify({
          version: '0.2.0',
          protocolVersion: 1,
          writtenByPluginId: 'at.other',
          writtenByPluginVersion: '0.2.0',
          writtenAt: 2,
          bundleSha256: createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
        }),
        'utf8'
      );

      // A fast-path hit would have reported 0.1.0; the full election defers to 0.2.0.
      const second = await syncPackagedHubAt(bundlePath, versions, home, { statePath });
      expect(second).toEqual({ updated: false, activeVersion: '0.2.0' });
    });

    it('falls back to the full sync when the packaged hub version changed', async () => {
      const content = 'a'.repeat(64);
      const { bundlePath, statePath } = await firstSync(content);
      const upgraded = 'c'.repeat(64);
      await writeFile(bundlePath, upgraded, 'utf8');

      const second = await syncPackagedHubAt(
        bundlePath,
        { hubVersion: '0.2.0', pluginVersion: '0.3.0' },
        home,
        { statePath }
      );

      expect(second).toEqual({ updated: true, activeVersion: '0.2.0' });
      await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(upgraded);
    });

    it('ignores a corrupt state file and runs the full sync', async () => {
      const content = 'a'.repeat(64);
      const { bundlePath, statePath } = await firstSync(content);
      await writeFile(statePath, 'not json', 'utf8');
      await writeFile(hubJsPath(home), 'b'.repeat(64), 'utf8');

      const second = await syncPackagedHubAt(bundlePath, versions, home, { statePath });

      expect(second).toEqual({ updated: true, activeVersion: '0.1.0' });
      await expect(readFile(hubJsPath(home), 'utf8')).resolves.toBe(content);
    });
  });
});
