import { createHash } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { AppError } from '../shared/types';
import { collectBuiltinAssets } from './builtin-assets';
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
      'Built-in skill extraction path must be a regular directory.',
    );
}
export async function materializeBuiltins(dataDir: string): Promise<string> {
  const files = await collectBuiltinAssets();
  const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  const data = resolve(dataDir);
  await mkdir(data, { recursive: true });
  const root = join(data, 'builtin-skills', version);
  await directory(join(data, 'builtin-skills'));
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
        `Built-in resource was modified: ${relative(data, path)}. Remove the built-in version directory to restore it, or disable built-in skills.`,
      );
    }
  }
  return root;
}
