import { readFile, readdir, mkdir, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AppError } from './types';
import { resolve, join, relative } from 'node:path';

export async function collectTextAssets(
  directory: string,
  parent = '',
): Promise<Record<string, string>> {
  const assets: Record<string, string> = Object.create(null);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const entry of entries) {
    const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Built-in assets cannot contain symbolic links: ${relativePath}`);
    if (entry.isDirectory()) {
      Object.assign(assets, await collectTextAssets(path, relativePath));
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

async function directory(path: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new AppError(
      'builtin_path',
      'Built-in asset extraction path must be a regular directory.',
    );
}
export async function materializeAssets(
  dataDir: string,
  directoryName: string,
  files: Record<string, string>,
): Promise<string> {
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  const data = resolve(dataDir);
  await mkdir(data, { recursive: true });
  const root = join(data, directoryName, version);
  await directory(join(data, directoryName));
  await directory(root);
  for (const [name, content] of Object.entries(files)) {
    const parts = name.split('/');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      await directory(parent);
    }
    const path = join(parent, parts.at(-1)!);
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || (await readFile(path, 'utf8')) !== content) {
      throw new AppError(
        'builtin_modified',
        `Built-in resource was modified: ${relative(data, path)}. Remove the built-in version directory to restore it, or disable the corresponding built-in feature.`,
      );
    }
  }
  return root;
}

export const hashText = (value: string) => createHash('sha256').update(value).digest('hex');
