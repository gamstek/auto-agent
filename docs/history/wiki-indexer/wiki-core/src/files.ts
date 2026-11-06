import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  matchesGlob,
} from 'node:path';
import { createHash } from 'node:crypto';
import { WikiError, type Source } from './contracts';

export const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
};
export interface SourceFile {
  source: Source;
  path: string;
  relativePath: string;
  root: string;
  bytes: number;
}
export async function scan(source: Source, signal: AbortSignal): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const selected = resolve(source.path);
  const root = source.type === 'directory' ? selected : dirname(selected);
  const canonical = await realpath(root);
  // Reject link ancestors, including a configured path that resolves through a link.
  for (let current = selected; ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink())
      throw new WikiError('source_path', 'Source paths must not use symbolic links');
    if (dirname(current) === current) break;
  }
  const includes = source.include;
  const excludes = source.exclude;
  const walk = async (path: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 16) throw new WikiError('source_limit', 'Source tree exceeds depth limit');
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !within(canonical, await realpath(path)))
      throw new WikiError('source_path', 'Source contains a symbolic link or escaped its root');
    const name = relative(root, path).split(sep).join('/');
    if (
      name &&
      excludes.some((pattern) => matchesGlob(name, pattern) || matchesGlob(name + '/', pattern))
    )
      return;
    if (stat.isDirectory()) {
      if (source.type === 'file')
        throw new WikiError('source_type', 'File source points to a directory');
      for (const entry of (await readdir(path)).sort()) {
        if (entry.startsWith('.')) continue;
        await walk(join(path, entry), depth + 1);
      }
    } else if (stat.isFile()) {
      if (path === selected && source.type === 'directory')
        throw new WikiError('source_type', 'Directory source points to a file');
      if (!includes.some((pattern) => matchesGlob(name || basename(path), pattern))) return;
      if (files.length >= 10000)
        throw new WikiError('source_limit', 'Source exceeds 10,000 documents');
      files.push({
        source,
        path,
        relativePath: name || basename(path),
        root: canonical,
        bytes: stat.size,
      });
    } else throw new WikiError('source_path', 'Source is not a regular file or directory');
  };
  await walk(selected, 0);
  return files;
}
export async function readSnapshot(file: SourceFile, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!within(file.root, await realpath(file.path)))
    throw new WikiError('source_path', 'Source escaped its root');
  const before = await lstat(file.path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new WikiError('source_path', 'Source changed its file type');
  if (before.size > 32 * 1024 * 1024) throw new WikiError('source_limit', 'Source exceeds 32 MiB');
  const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      !within(file.root, await realpath(file.path))
    )
      throw new WikiError('source_changed', 'Source changed while opening');
    const bytes = new Uint8Array(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const result = await handle.read(
        bytes,
        offset,
        Math.min(1024 * 1024, bytes.length - offset),
        offset,
      );
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== bytes.length ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new WikiError('source_changed', 'Source changed while reading');
    return { path: file.relativePath, bytes, sha256: hash(bytes) };
  } finally {
    await handle.close();
  }
}
