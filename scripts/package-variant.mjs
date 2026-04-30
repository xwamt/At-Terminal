import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const variant = process.argv[2];
if (!['base', 'mcp'].includes(variant)) {
  throw new Error('Usage: node scripts/package-variant.mjs base|mcp');
}

const root = process.cwd();
const stage = join(root, '.package-work', variant);
const manifestName = variant === 'base' ? 'package.base.json' : 'package.mcp.json';
const readmeName = variant === 'base' ? 'README-base.md' : 'README.md';
const manifest = JSON.parse(await readFile(join(root, manifestName), 'utf8'));

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
if (variant === 'base') {
  await rm(join(stage, 'dist', 'mcp-server.js'), { force: true });
  await rm(join(stage, 'dist', 'mcp-server.js.map'), { force: true });
}
await cp(join(root, 'media'), join(stage, 'media'), { recursive: true });
await cp(join(root, 'webview'), join(stage, 'webview'), { recursive: true });
await cp(join(root, '.vscodeignore'), join(stage, '.vscodeignore'));
await writeFile(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await cp(join(root, readmeName), join(stage, 'README.md'));

const install = spawnSync(
  process.platform === 'win32' ? 'cmd' : 'npm',
  process.platform === 'win32'
    ? ['/c', 'npm', 'install', '--omit=dev', '--package-lock=false', '--ignore-scripts']
    : ['install', '--omit=dev', '--package-lock=false', '--ignore-scripts'],
  { cwd: stage, stdio: 'inherit' }
);
if (install.status !== 0) {
  process.exit(install.status ?? 1);
}

const result = spawnSync(
  process.platform === 'win32' ? 'cmd' : 'npx',
  process.platform === 'win32'
    ? [
        '/c',
        'npx',
        '@vscode/vsce',
        'package',
        '--allow-missing-repository',
        '--baseContentUrl',
        'https://example.com/at-terminal',
        '--baseImagesUrl',
        'https://example.com/at-terminal'
      ]
    : [
        '@vscode/vsce',
        'package',
        '--allow-missing-repository',
        '--baseContentUrl',
        'https://example.com/at-terminal',
        '--baseImagesUrl',
        'https://example.com/at-terminal'
      ],
  { cwd: stage, stdio: 'inherit' }
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const vsixName = `${manifest.name}-${manifest.version}.vsix`;
await cp(join(stage, vsixName), join(root, vsixName));
