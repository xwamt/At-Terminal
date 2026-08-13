import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const variantArg = process.argv.find((arg) => arg.startsWith('--variant=')) ?? '--variant=mcp';
const variant = variantArg.split('=')[1];
if (!['base', 'mcp'].includes(variant)) {
  throw new Error(`Unknown build variant: ${variant}`);
}
const mcpEnabled = variant === 'mcp';

// Maps are excluded from the VSIX by .vscodeignore, so emitting them in a production
// build would only leave a sourceMappingURL pointing at a file that never ships.
const common = {
  bundle: true,
  sourcemap: watch,
  minify: !watch,
  define: {
    MCP_ENABLED: JSON.stringify(mcpEnabled)
  }
};

// VS Code ^1.85 runs on Electron 25: Node 18 in the extension host, Chromium 114 in
// webviews.
const HOST_TARGET = 'node18';
const WEBVIEW_TARGET = 'chrome114';

/**
 * Cut `@at-series/mcp-hub` out of the base bundle.
 *
 * Every call into it sits behind `if (MCP_ENABLED)`, so the base variant already
 * drops the call sites — but the package is CommonJS, and esbuild cannot
 * tree-shake into a CJS module. A single surviving `import` statement therefore
 * drags in the whole thing plus js-yaml and semver.
 *
 * The stub is generated from the real module's own export list rather than
 * hand-maintained, so adding an export to the hub cannot silently desync it.
 * Every binding is `undefined`; that is safe precisely because the base variant
 * has no reachable path to any of them, and the assertions in
 * test/package.baseBundle.test.ts fail if that ever stops being true.
 */
function stubMcpHubPlugin() {
  return {
    name: 'stub-mcp-hub',
    setup(build) {
      build.onResolve({ filter: /^@at-series\/mcp-hub$/ }, () => ({
        path: '@at-series/mcp-hub',
        namespace: 'stub-mcp-hub'
      }));
      build.onLoad({ filter: /.*/, namespace: 'stub-mcp-hub' }, async () => {
        const real = await import('@at-series/mcp-hub');
        // Importing a CommonJS module yields interop keys such as
        // `module.exports` alongside the real ones; only identifiers can be
        // re-declared as exports.
        const names = Object.keys(real).filter(
          (name) => name !== 'default' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
        );
        return {
          contents: names.map((name) => `export const ${name} = undefined;`).join('\n'),
          loader: 'js'
        };
      });
    }
  };
}

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    target: HOST_TARGET,
    format: 'cjs',
    external: ['vscode', 'ssh2'],
    plugins: mcpEnabled ? [] : [stubMcpHubPlugin()]
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/terminal/index.ts'],
    outfile: 'dist/webview/terminal.js',
    platform: 'browser',
    target: WEBVIEW_TARGET,
    format: 'iife'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/server-form/index.ts'],
    outfile: 'dist/webview/server-form.js',
    platform: 'browser',
    target: WEBVIEW_TARGET,
    format: 'iife'
  })
];

const contexts = await Promise.all(contextConfigs);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension and webview bundles...');
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
