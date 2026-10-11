import { constants } from 'node:fs';
import { lstat, readdir, open } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Config } from '../config';
import { AppError } from '../shared/types';
import { materializeBuiltins } from '../shared/builtin';
import { hashText as hash } from '../shared/assets';
import type { Source } from './knowledge';

export function sourceRoot(config: Config): string {
  return JSON.stringify({
    builtinWiki: config.builtinWiki,
    wikiRoots: config.wikiRoots.map((root) => resolve(root)),
  });
}

export async function readSources(config: Config): Promise<Source[]> {
  const roots: { path: string; prefix: string }[] = [];
  if (config.builtinWiki)
    roots.push({
      path: await materializeBuiltins(config.dataDir, 'wiki'),
      prefix: 'builtin',
    });
  for (const path of config.wikiRoots)
    roots.push({ path: resolve(path), prefix: `external-${hash(resolve(path)).slice(0, 16)}` });
  const sources: Source[] = [];
  let bytes = 0;
  for (const configured of roots) {
    const root = configured.path;
    // Reject symlink ancestors as well as entries to keep the configured source tree explicit.
    let current = root;
    while (true) {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new AppError('wiki_path', 'Wiki directory must not use symbolic links');
      const parent = resolve(current, '..');
      if (parent === current) break;
      current = parent;
    }
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 10) throw new AppError('wiki_limit', 'Wiki source tree is too deep');
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink())
          throw new AppError('wiki_path', 'Wiki source entries must not be symbolic links');
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path, depth + 1);
          continue;
        }
        if (!entry.isFile() || !/\.(md|txt)$/i.test(entry.name)) continue;
        const before = await lstat(path);
        const size = before.size;
        if (before.isSymbolicLink() || !before.isFile())
          throw new AppError('wiki_path', 'Wiki source must be a regular file');
        if (
          size > config.resourceLimitBytes ||
          bytes + size > 2 * 1024 * 1024 ||
          sources.length >= 100
        )
          throw new AppError(
            'wiki_limit',
            'Wiki sources exceed file, byte or count limits; split large documents',
          );
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let buffer: Buffer;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
            throw new AppError('wiki_path', 'Wiki source changed while opening');
          buffer = Buffer.alloc(config.resourceLimitBytes + 1);
          let length = 0;
          while (length < buffer.length) {
            const read = await handle.read(buffer, length, buffer.length - length, null);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          buffer = buffer.subarray(0, length);
        } finally {
          await handle.close();
        }
        if (buffer.length > config.resourceLimitBytes || bytes + buffer.length > 2 * 1024 * 1024)
          throw new AppError('wiki_limit', 'Wiki source exceeds byte limit');
        const text = buffer.toString('utf8');
        if (!Buffer.from(text).equals(buffer))
          throw new AppError('wiki_encoding', 'Wiki sources must be UTF-8');
        bytes += buffer.length;
        sources.push({
          path: `${configured.prefix}/${relative(root, path).split(sep).join('/')}`,
          hash: hash(text),
          text,
        });
      }
    };
    await walk(root, 0);
  }
  return sources;
}
