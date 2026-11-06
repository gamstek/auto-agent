import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
await build({
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(root, 'dist/server.js'),
  platform: 'node',
  target: 'node24',
  format: 'esm',
  bundle: true,
  packages: 'external',
});
await mkdir(resolve(root, 'dist'), { recursive: true });
await copyFile(resolve(root, 'src/sam/sam-profiles.json'), resolve(root, 'dist/sam-profiles.json'));
