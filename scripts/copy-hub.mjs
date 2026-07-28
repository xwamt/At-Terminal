import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const hubEntry = require.resolve('@at-series/mcp-hub/hub');
const hubPkgPath = join(dirname(hubEntry), '..', 'package.json');
const hubPkg = JSON.parse(readFileSync(hubPkgPath, 'utf8'));

mkdirSync('dist', { recursive: true });
copyFileSync(hubEntry, join('dist', 'hub.js'));
writeFileSync(
  join('dist', 'hub-version.json'),
  `${JSON.stringify({ version: hubPkg.version, protocolVersion: 1 }, null, 2)}\n`,
  'utf8'
);
console.log(`copied hub.js (${hubPkg.version}) + hub-version.json`);
