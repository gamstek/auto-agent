import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectBuiltinAssets } from '../src/shared/builtin';
import { Database } from 'bun:sqlite';
import { builtinParsers } from '@auto-agent/wiki-core';
import { samParser } from '@auto-agent/wiki-sam';

const platform = process.argv[2];
if (platform !== 'windows' && platform !== 'linux')
  throw new Error('Usage: bun scripts/build.ts windows|linux [outfile]');

const root = resolve(import.meta.dir, '..');
const assetsModule = resolve(root, 'src', 'shared', 'builtin.ts');
const indexModule = resolve(root, 'src', 'shared', 'builtin-index.ts');
function validateBuiltinWiki(assets: Record<string, string>): void {
  const db = new Database(resolve(root, 'wiki/reference/library.sqlite'), { readonly: true });
  try {
    if (db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version !== 3)
      throw new Error('Published Wiki index does not match the current schema');
    const parsers = new Map([...builtinParsers, samParser].map((parser) => [parser.id, parser.version]));
    for (const row of db.query<{ parserId: string; parserVersion: string }, []>('SELECT DISTINCT parserId,parserVersion FROM representations').all())
      if (parsers.get(row.parserId) !== row.parserVersion) throw new Error('Rebuild the published Wiki index with the current parsers');
    for (const [path, content] of Object.entries(assets)) {
      if (!path.startsWith('sources/') || !/\.(md|txt)$/i.test(path)) continue;
      const units = db.query<{ text: string }, [string]>(`SELECT u.text FROM documents d JOIN representations r ON r.id=d.representationId
        JOIN units u ON u.representationId=r.id WHERE d.active=1 AND d.path=? AND r.parserId IN ('builtin.markdown','builtin.text') ORDER BY u.ordinal`).all(path.slice('sources/'.length));
      if (units.map((unit) => unit.text).join('\n') !== content.replace(/\r\n/g, '\n')) throw new Error('Published Wiki text is stale; run scripts/publish-wiki.ts');
    }
  } finally { db.close(); }
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
        build.onLoad({ filter: /builtin-index\.ts$/ }, async (args) => {
          if (resolve(args.path) !== indexModule) return;
          const source = await readFile(args.path, 'utf8');
          const collector = /export function collectBuiltinIndex\([\s\S]*?\n\}/;
          if (!collector.test(source)) throw new Error('Wiki index collector not found');
          return {
            loader: 'ts',
            contents:
              `import embeddedIndex from ${JSON.stringify(resolve(root, 'wiki/reference/library.sqlite'))} with { type: 'file' };\n` +
              source.replace(
                collector,
                'export function collectBuiltinIndex(): Uint8Array { return readFileSync(embeddedIndex); }',
              ),
          };
        });
        build.onLoad({ filter: /builtin\.ts$/ }, async (args) => {
          if (resolve(args.path) !== assetsModule) return;
          const [skills, wiki] = await Promise.all([
            collectBuiltinAssets('skills'),
            collectBuiltinAssets('wiki'),
          ]);
          validateBuiltinWiki(wiki);
          const source = await readFile(args.path, 'utf8');
          const collector = /export (?:async )?function collectBuiltinAssets\([\s\S]*?\n\}/;
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
