import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The base variant is the agentless product. Manifest-level checks live in
 * package.variants.test.ts; this file asserts on the artifact itself, because the
 * manifest can be clean while `MCP_ENABLED` still fails to fold and drags the whole
 * bridge into the bundle.
 *
 * Assertions use string literals rather than identifiers: a minified bundle renames
 * `createBridgeRequestHandler` regardless of whether its body survived.
 *
 * Known residue: `@at-series/mcp-hub` is CommonJS, and esbuild keeps a statically
 * imported CJS module even when every consumer is eliminated. Its constants and the
 * tool catalog therefore still appear in the base bundle even though no code path can
 * reach them. Only assertions that actually hold belong here.
 */
let baseBundle = '';
let mcpBundle = '';

let mcpPolicyRuntimeExists = false;
let mcpPolicyRuntimeContainsEvaluator = false;
let mcpPolicyAssetBytes = 0;
let mcpPolicyCompressedBytes = 0;
let mcpPolicyAllowsUptime = false;
let mcpPolicyReviewsWrite = false;

const require = createRequire(__filename);

function build(variant: 'base' | 'mcp'): string {
  execFileSync(process.execPath, ['esbuild.config.mjs', `--variant=${variant}`], { stdio: 'pipe' });
  return readFileSync('dist/extension.js', 'utf8');
}

beforeAll(async () => {
  mcpBundle = build('mcp');
  mcpPolicyRuntimeExists = existsSync('dist/policy-runtime.js');
  mcpPolicyRuntimeContainsEvaluator = mcpPolicyRuntimeExists
    && readFileSync('dist/policy-runtime.js', 'utf8').includes('createTerminalPolicyRuntime');
  const wasmFiles = existsSync('dist/policy-assets')
    ? readdirSync('dist/policy-assets').filter((name) => name.endsWith('.wasm'))
    : [];
  mcpPolicyAssetBytes = wasmFiles.reduce(
    (total, name) => total + statSync(join('dist/policy-assets', name)).size,
    0
  );
  if (mcpPolicyRuntimeExists) {
    mcpPolicyCompressedBytes = gzipSync(readFileSync('dist/policy-runtime.js')).length
      + wasmFiles.reduce(
        (total, name) => total + gzipSync(readFileSync(join('dist/policy-assets', name))).length,
        0
      );
    const runtime = require(join(process.cwd(), 'dist/policy-runtime.js')) as {
      createTerminalPolicyRuntime(options: { assetDirectory: string }): {
        evaluate(input: { sourceText: string }): Promise<{ action: string }>;
      };
    };
    const evaluator = runtime.createTerminalPolicyRuntime({
      assetDirectory: join(process.cwd(), 'dist/policy-assets')
    });
    const allowed = await evaluator.evaluate({ sourceText: 'uptime' });
    const reviewed = await evaluator.evaluate({ sourceText: 'rm -rf /tmp/app' });
    mcpPolicyAllowsUptime = allowed.action === 'allow';
    mcpPolicyReviewsWrite = reviewed.action !== 'allow';
  }
  baseBundle = build('base');
}, 120_000);

describe('base variant bundle', () => {
  it('drops the MCP bridge instead of shipping it behind a disabled flag', () => {
    expect(mcpBundle).toContain('Unauthorized MCP bridge request.');
    expect(baseBundle).not.toContain('createBridgeRequestHandler');
    expect(baseBundle).not.toContain('Unauthorized MCP bridge request.');
    expect(baseBundle).not.toContain('AT Terminal MCP bridge');
  });

  it('drops the MCP config install and uninstall commands', () => {
    expect(mcpBundle).toContain('sshManager.installMcpConfig');
    expect(baseBundle).not.toContain('sshManager.installMcpConfig');
    expect(baseBundle).not.toContain('sshManager.uninstallAtSeriesMcpConfig');
  });

  it('drops the hub package, and js-yaml and semver along with it', () => {
    // The hub is CommonJS, so esbuild cannot tree-shake into it: one surviving
    // import statement is enough to drag in the whole package and both of its
    // dependencies, even with every call site already eliminated. These are
    // runtime strings from js-yaml and semver, which minification preserves.
    expect(mcpBundle).toContain('unacceptable kind of an object');
    expect(mcpBundle).toContain('Invalid comparator');
    expect(baseBundle).not.toContain('unacceptable kind of an object');
    expect(baseBundle).not.toContain('Invalid comparator');
  });

  it('is meaningfully smaller than the MCP variant', () => {
    expect(baseBundle.length).toBeLessThan(mcpBundle.length * 0.95);
  });

  it('ships a minified bundle', () => {
    const { size } = statSync('dist/extension.js');
    const averageLineLength = size / (baseBundle.split('\n').length || 1);

    expect(averageLineLength).toBeGreaterThan(200);
  });

  it('leaves no sourceMappingURL behind, since .vscodeignore keeps maps out of the VSIX', () => {
    expect(readFileSync('.vscodeignore', 'utf8')).toContain('**/*.map');
    expect(baseBundle).not.toContain('sourceMappingURL');
  });

  it('keeps shared command policy out of the base bundle and off the base disk layout', () => {
    expect(mcpPolicyRuntimeExists).toBe(true);
    expect(mcpPolicyRuntimeContainsEvaluator).toBe(true);
    expect(mcpPolicyAllowsUptime).toBe(true);
    expect(mcpPolicyReviewsWrite).toBe(true);
    expect(mcpPolicyAssetBytes).toBeGreaterThan(0);
    expect(mcpPolicyAssetBytes).toBeLessThanOrEqual(2.5 * 1024 * 1024);
    expect(mcpPolicyCompressedBytes).toBeGreaterThan(0);
    expect(mcpPolicyCompressedBytes).toBeLessThanOrEqual(500 * 1024);
    expect(baseBundle).not.toContain('createTerminalPolicyRuntime');
    expect(baseBundle).not.toContain('createShellPolicyEvaluator');
    expect(baseBundle).not.toContain('tree-sitter-bash');
    expect(baseBundle).not.toContain('@at-series/command-policy');
    expect(mcpBundle).not.toContain('createShellPolicyEvaluator');
    expect(mcpBundle).not.toContain('tree-sitter-bash');
    expect(existsSync('dist/policy-runtime.js')).toBe(false);
    expect(existsSync('dist/policy-assets')).toBe(false);
  });
});
