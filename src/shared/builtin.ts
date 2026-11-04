import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { collectTextAssets, materializeAssets } from './assets';

export async function collectBuiltinAssets(
  kind: 'skills' | 'wiki',
): Promise<Record<string, string>> {
  const root = resolve(import.meta.dir, '..', '..', kind);
  if (kind === 'skills') return collectTextAssets(root);
  const sources = await collectTextAssets(resolve(root, 'sources'));
  return Object.fromEntries([
    ['README.md', await readFile(resolve(root, 'README.md'), 'utf8')],
    ...Object.entries(sources).map(([path, text]) => [`sources/${path}`, text]),
  ]);
}

export async function materializeBuiltins(
  dataDir: string,
  kind: 'skills' | 'wiki',
): Promise<string> {
  return materializeAssets(dataDir, `builtin-${kind}`, await collectBuiltinAssets(kind));
}
