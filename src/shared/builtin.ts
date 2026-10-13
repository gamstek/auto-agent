import { resolve } from 'node:path';
import { collectTextAssets, materializeAssets } from './assets';

export function collectBuiltinAssets(kind: 'skills' | 'wiki'): Promise<Record<string, string>> {
  return collectTextAssets(resolve(import.meta.dir, '..', '..', kind));
}

export async function collectBuiltinWikiSnapshot(): Promise<string> {
  const snapshot = (await collectBuiltinAssets('wiki'))['_knowledge.json'];
  if (snapshot === undefined) throw new Error('Built-in wiki knowledge snapshot is missing');
  return snapshot;
}

export async function materializeBuiltins(
  dataDir: string,
  kind: 'skills' | 'wiki',
): Promise<string> {
  return materializeAssets(dataDir, `builtin-${kind}`, await collectBuiltinAssets(kind));
}
