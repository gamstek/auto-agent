import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectBuiltinAssets } from '../src/skill/builtin-assets';

const platform = process.argv[2];
if (platform !== 'windows' && platform !== 'linux')
  throw new Error('Usage: bun scripts/build.ts windows|linux [outfile]');

const root = resolve(import.meta.dir, '..');
const assetsModule = resolve(root, 'src', 'skills', 'builtin-assets.ts');
await mkdir(resolve(root, 'dist'), { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, 'src', 'index.ts')],
  target: 'bun',
  format: 'esm',
  minify: true,
  compile: {
    target: platform === 'windows' ? 'bun-windows-x64' : 'bun-linux-x64',
    outfile: process.argv[3]
      ? resolve(process.argv[3])
      : resolve(root, 'dist', platform === 'windows' ? 'auto-agent.exe' : 'auto-agent'),
  },
  plugins: [
    {
      name: 'builtin-assets',
      setup(build) {
        build.onLoad({ filter: /builtin-assets\.ts$/ }, async (args) => {
          if (resolve(args.path) !== assetsModule) return;
          const assets = await collectBuiltinAssets();
          return {
            contents: `export async function collectBuiltinAssets() { return ${JSON.stringify(assets)}; }`,
            loader: 'js',
          };
        });
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
