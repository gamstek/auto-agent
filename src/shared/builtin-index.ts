import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from './types';

export function collectBuiltinIndex(): Uint8Array {
  return readFileSync(resolve(import.meta.dir, '../../wiki/indexes/library.sqlite'));
}
export function materializeBuiltinIndex(dataDir: string): string {
  const bytes = collectBuiltinIndex();
  if (
    bytes.length > 64 * 1024 * 1024 ||
    Buffer.from(bytes.subarray(0, 16)).toString() !== 'SQLite format 3\0'
  )
    throw new AppError('wiki_snapshot', 'Invalid bundled template database');
  const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
  const hash = digest(bytes);
  mkdirSync(dataDir, { recursive: true });
  let directory = resolve(dataDir);
  for (const part of ['builtin-wiki-index', hash.slice(0, 16)]) {
    directory = join(directory, part);
    mkdirSync(directory, { recursive: true });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AppError('builtin_path', 'Wiki index release path is not a regular directory');
  }
  const path = join(directory, 'library.sqlite');
  try {
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || digest(readFileSync(path)) !== hash)
    throw new AppError('builtin_modified', 'Bundled template database was modified');
  return path;
}
