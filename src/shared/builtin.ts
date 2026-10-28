import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { collectTextAssets, materializeAssets } from './assets';

export async function collectBuiltinAssets(
  kind: 'skills' | 'wiki',
): Promise<Record<string, string>> {
  const root = resolve(import.meta.dir, '..', '..', kind);
  if (kind === 'skills') return collectTextAssets(root);
  const sources = await collectTextAssets(resolve(root, 'sources'));
  const knowledge = await collectTextAssets(resolve(root, 'knowledge'));
  return Object.fromEntries([
    ['README.md', await readFile(resolve(root, 'README.md'), 'utf8')],
    ...Object.entries(sources).map(([path, text]) => [`sources/${path}`, text]),
    ...Object.entries(knowledge).map(([path, text]) => [`knowledge/${path}`, text]),
  ]);
}

export async function collectBuiltinWikiSnapshot(): Promise<string> {
  const snapshot = (await collectBuiltinAssets('wiki'))['knowledge/recommendations.json'];
  if (snapshot === undefined) throw new Error('Built-in wiki knowledge snapshot is missing');
  return snapshot;
}

export async function materializeBuiltins(
  dataDir: string,
  kind: 'skills' | 'wiki',
): Promise<string> {
  return materializeAssets(dataDir, `builtin-${kind}`, await collectBuiltinAssets(kind));
}
