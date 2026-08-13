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

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    target: HOST_TARGET,
    format: 'cjs',
    external: ['vscode', 'ssh2']
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
