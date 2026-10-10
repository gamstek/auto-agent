import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

async function collect(directory: string, parent = ''): Promise<Record<string, string>> {
  const assets: Record<string, string> = Object.create(null);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Built-in assets cannot contain symbolic links: ${relativePath}`);
    if (entry.isDirectory()) {
      Object.assign(assets, await collect(path, relativePath));
    } else if (entry.isFile()) {
      const content = await readFile(path);
      const text = content.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(content))
        throw new Error(`Built-in assets must be UTF-8 text: ${relativePath}`);
      assets[relativePath] = text;
    } else throw new Error(`Unsupported built-in asset: ${relativePath}`);
  }
  return assets;
}

export function collectBuiltinAssets(
  directory = resolve(import.meta.dir, '..', '..', 'skills'),
): Promise<Record<string, string>> {
  return collect(directory);
}
