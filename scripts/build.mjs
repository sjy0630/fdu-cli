// 打包成一个可执行文件 dist/cli.js（依赖不打进去，安装时由 npm 装好）
import { build } from 'esbuild';
import { chmodSync, readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  define: { __FDU_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});
chmodSync('dist/cli.js', 0o755);
