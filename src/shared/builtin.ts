import { resolve } from 'node:path';
import { collectTextAssets, materializeAssets } from './assets';

export function collectBuiltinAssets(kind: 'skills' | 'wiki'): Promise<Record<string, string>> {
  return collectTextAssets(resolve(import.meta.dir, '..', '..', kind));
}

export async function materializeBuiltins(
  dataDir: string,
  kind: 'skills' | 'wiki',
): Promise<string> {
  return materializeAssets(dataDir, `builtin-${kind}`, await collectBuiltinAssets(kind));
}
