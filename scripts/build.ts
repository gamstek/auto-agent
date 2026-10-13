import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectBuiltinAssets } from '../src/shared/builtin';
import { bundledSnapshotSchema, sourceHash } from '../src/wiki/knowledge';

const platform = process.argv[2];
if (platform !== 'windows' && platform !== 'linux')
  throw new Error('Usage: bun scripts/build.ts windows|linux [outfile]');

const root = resolve(import.meta.dir, '..');
const assetsModule = resolve(root, 'src', 'shared', 'builtin.ts');
function validateBuiltinWiki(assets: Record<string, string>): void {
  const text = assets['_knowledge.json'];
  if (text === undefined) throw new Error('Built-in wiki knowledge snapshot is missing');
  const snapshot = bundledSnapshotSchema.parse(JSON.parse(text));
  const sources = Object.entries(assets)
    .filter(
      ([path]) =>
        /\.(md|txt)$/i.test(path) && !path.split('/').some((part) => part.startsWith('.')),
    )
    .map(([path, content]) => [`builtin/${path}`, sourceHash(content)] as const);
  const analyzed = snapshot.sources.map((source) => [source.path, source.hash] as const);
  if (JSON.stringify(analyzed) !== JSON.stringify(sources))
    throw new Error('Built-in wiki knowledge snapshot is stale; regenerate wiki/_knowledge.json');
}

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
        build.onLoad({ filter: /builtin\.ts$/ }, async (args) => {
          if (resolve(args.path) !== assetsModule) return;
          const [skills, wiki] = await Promise.all([
            collectBuiltinAssets('skills'),
            collectBuiltinAssets('wiki'),
          ]);
          validateBuiltinWiki(wiki);
          const source = await readFile(args.path, 'utf8');
          const collector = /export function collectBuiltinAssets\([\s\S]*?\n\}/;
          if (!collector.test(source))
            throw new Error('Built-in collector not found; cannot embed assets');
          return {
            contents: source.replace(
              collector,
              () => `export async function collectBuiltinAssets(kind: 'skills' | 'wiki'): Promise<Record<string, string>> {
  return ${JSON.stringify({ skills, wiki })}[kind];
}`,
            ),
            loader: 'ts',
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
