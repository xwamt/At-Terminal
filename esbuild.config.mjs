import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const variantArg = process.argv.find((arg) => arg.startsWith('--variant=')) ?? '--variant=mcp';
const variant = variantArg.split('=')[1];
if (!['base', 'mcp'].includes(variant)) {
  throw new Error(`Unknown build variant: ${variant}`);
}
const mcpEnabled = variant === 'mcp';

const common = {
  bundle: true,
  sourcemap: true,
  minify: false,
  define: {
    __AT_TERMINAL_MCP_ENABLED__: JSON.stringify(mcpEnabled)
  }
};

const contextConfigs = [
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode', 'ssh2']
  }),
  ...(mcpEnabled
    ? [
        esbuild.context({
          ...common,
          entryPoints: ['src/mcp/server.ts'],
          outfile: 'dist/mcp-server.js',
          platform: 'node',
          format: 'cjs',
          external: ['vscode']
        })
      ]
    : []),
  esbuild.context({
    ...common,
    entryPoints: ['webview/terminal/index.ts'],
    outfile: 'dist/webview/terminal.js',
    platform: 'browser',
    format: 'iife'
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/server-form/index.ts'],
    outfile: 'dist/webview/server-form.js',
    platform: 'browser',
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
