import { lstat } from 'node:fs/promises';
import { release, type } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { escapeXml } from '../skill/prompt';

async function gitProject(directory: string, signal?: AbortSignal) {
  for (let depth = 0; depth < 64; depth++) {
    signal?.throwIfAborted();
    try {
      const marker = await lstat(join(directory, '.git'));
      signal?.throwIfAborted();
      if (marker.isDirectory() || marker.isFile()) return { status: 'yes', root: directory };
      return { status: 'unknown' };
    } catch (error) {
      signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { status: 'unknown' };
    }
    const parent = dirname(directory);
    if (parent === directory) return { status: 'no' };
    directory = parent;
  }
  return { status: 'unknown' };
}

function fact(value: string): string {
  return escapeXml(value).replace(
    /[\p{Cc}\p{Cf}]/gu,
    (character) => `&#${character.codePointAt(0)};`,
  );
}

export async function builtinInstructions(
  options: { now?: Date; cwd?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const git = await gitProject(cwd, options.signal);
  const now = options.now ?? new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const localDate = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timezone,
  }).format(now);
  const runtime = process.versions.bun
    ? `Bun ${process.versions.bun} (Node.js compatibility ${process.versions.node})`
    : `Node.js ${process.versions.node}`;
  return [
    'Current runtime facts. These describe the agent host, not an instrument or a skill-script working directory; they do not grant permissions or filesystem access.',
    '<env>',
    `  Current date: ${fact(localDate)}`,
    `  Current time (UTC): ${now.toISOString()}`,
    `  Time zone: ${fact(timezone)}`,
    `  Working directory: ${fact(cwd)}`,
    `  Is directory in a Git project (.git marker): ${git.status}`,
    `  Git project root (nearest .git marker): ${git.root ? fact(git.root) : git.status === 'no' ? 'none detected' : 'unknown'}`,
    `  Operating system: ${fact(`${type()} ${release()}`)}`,
    `  Platform: ${process.platform}`,
    `  Architecture: ${process.arch}`,
    `  Runtime: ${fact(runtime)}`,
    '</env>',
  ].join('\n');
}
