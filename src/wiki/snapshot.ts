import { randomUUID } from 'node:crypto';
import { lstat, readFile, mkdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config';
import { AppError } from '../shared/types';
import { collectBuiltinWikiSnapshot } from '../shared/builtin';
import { bundledSnapshotSchema, snapshotSchema, type Snapshot } from './knowledge';
import { hashText as hash } from '../shared/assets';
import { sourceRoot } from './sources';

export function snapshotPath(config: Config): string {
  return join(config.dataDir, 'wiki', 'snapshot.json');
}

export async function loadStoredSnapshot(config: Config): Promise<Snapshot | undefined> {
  try {
    const path = snapshotPath(config);
    if ((await lstat(path)).size > 8 * 1024 * 1024)
      throw new AppError('wiki_limit', 'Wiki snapshot is too large');
    return snapshotSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AppError(
      'wiki_snapshot',
      'Wiki snapshot is invalid; run an explicit knowledge update',
    );
  }
}

export async function loadBundledSnapshot(config: Config): Promise<Snapshot | undefined> {
  if (!config.builtinWiki) return undefined;
  try {
    const snapshot = bundledSnapshotSchema.parse(JSON.parse(await collectBuiltinWikiSnapshot()));
    return { ...snapshot, root: sourceRoot(config) };
  } catch {
    throw new AppError('wiki_snapshot', 'Built-in wiki knowledge snapshot is invalid');
  }
}

export async function loadSnapshot(config: Config): Promise<Snapshot | undefined> {
  const stored = await loadStoredSnapshot(config);
  if (stored || config.wikiRoots.length) return stored;
  return loadBundledSnapshot(config);
}

export async function saveSnapshot(
  config: Config,
  snapshot: Snapshot,
  signal: AbortSignal,
): Promise<void> {
  const content = JSON.stringify(snapshot);
  if (Buffer.byteLength(content) > 8 * 1024 * 1024)
    throw new AppError('wiki_limit', 'Generated knowledge exceeds snapshot limit');
  signal.throwIfAborted();
  await mkdir(join(config.dataDir, 'wiki'), { recursive: true });
  const temporary = `${snapshotPath(config)}.${randomUUID()}.tmp`;
  const exportDir = join(config.dataDir, 'wiki', 'revisions', hash(content));
  try {
    await mkdir(exportDir, { recursive: true });
    const markdown = [
      '# Instrument automation knowledge',
      '',
      `Build: ${snapshot.builtAt}`,
      '',
      'Recommendations only. Source citations are checked for existence, not semantic validity.',
      '',
      ...snapshot.sources.flatMap((source) => [
        `## Source: ${source.path}`,
        '',
        source.knowledge.summary,
        '',
        ...source.knowledge.issues.map((issue) => `- Source issue: ${issue}`),
        '',
        ...source.knowledge.records.flatMap((record) => [
          `### ${record.title}`,
          '',
          ...Object.entries(record.facts).map(
            ([field, fact]) =>
              `- ${field}: ${fact.value} (source lines: ${fact.citations.map((ref) => ref.line).join(', ')})`,
          ),
          ...record.issues.map((issue) => `- Issue: ${issue}`),
          '',
        ]),
      ]),
    ].join('\n');
    await writeFile(join(exportDir, 'index.md'), markdown, { mode: 0o600 });
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    signal.throwIfAborted();
    await rename(temporary, snapshotPath(config));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
