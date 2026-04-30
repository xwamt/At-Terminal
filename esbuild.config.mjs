import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  minify: false
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode', 'ssh2']
  }),
  esbuild.context({
    ...common,
    entryPoints: ['src/mcp/server.ts'],
    outfile: 'dist/mcp-server.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode']
  }),
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
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching extension and webview bundles...');
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
