import { resolve } from 'node:path';
import type { Config } from '../config';
import { AppError, type ModelAdapter } from '../shared/types';
import { revision, type Snapshot } from './knowledge';
import { knowledgeSchema, type Knowledge, type Source, parseKnowledge } from './knowledge';
import { readSources, sourceRoot } from './sources';
import { loadBundledSnapshot, loadStoredSnapshot, saveSnapshot, snapshotPath } from './snapshot';

const activeUpdates = new Set<string>();

export async function updateWiki(
  config: Config,
  model: ModelAdapter,
  signal: AbortSignal,
): Promise<{ sources: number; rebuilt: number; builtAt: number }> {
  const key = resolve(snapshotPath(config));
  if (activeUpdates.has(key))
    throw new AppError('wiki_busy', 'Knowledge update already running', 409);
  activeUpdates.add(key);
  try {
    return await build(config, model, signal);
  } finally {
    activeUpdates.delete(key);
  }
}
async function build(
  config: Config,
  model: ModelAdapter,
  signal: AbortSignal,
): Promise<{ sources: number; rebuilt: number; builtAt: number }> {
  const sources = await readSources(config);
  if (!sources.length) throw new AppError('wiki_empty', 'No Markdown or text sources found');
  const previous = await loadStoredSnapshot(config).catch((error) => {
    if (error instanceof AppError && error.code === 'wiki_snapshot') return undefined;
    throw error;
  });
  const bundled = await loadBundledSnapshot(config);
  let rebuilt = 0;
  const entries: Snapshot['sources'] = [];
  for (const source of sources) {
    signal.throwIfAborted();
    const cached =
      (previous?.root === sourceRoot(config)
        ? previous.sources.find((s) => s.path === source.path && s.hash === source.hash)
        : undefined) ??
      bundled?.sources.find((s) => s.path === source.path && s.hash === source.hash);
    if (cached) {
      entries.push(cached);
      continue;
    }
    const knowledge = await extractKnowledge(config, model, source, signal);
    entries.push({ path: source.path, hash: source.hash, knowledge });
    rebuilt++;
  }
  if (!rebuilt && previous && entries.length === previous.sources.length)
    return { sources: entries.length, rebuilt: 0, builtAt: previous.builtAt };
  const latest = await readSources(config);
  if (
    JSON.stringify(latest.map((s) => [s.path, s.hash])) !==
    JSON.stringify(sources.map((s) => [s.path, s.hash]))
  )
    throw new AppError('wiki_changed', 'Sources changed during build; update again');
  const snapshot: Snapshot = {
    revision,
    root: sourceRoot(config),
    builtAt: Date.now(),
    sources: entries,
  };
  await saveSnapshot(config, snapshot, signal);
  return { sources: entries.length, rebuilt, builtAt: snapshot.builtAt };
}

async function extractKnowledge(
  config: Config,
  model: ModelAdapter,
  source: Source,
  signal: AbortSignal,
): Promise<Knowledge> {
  if (!model.generateKnowledge)
    throw new AppError('wiki_model', 'Model does not support knowledge generation');
  const lines = source.text.split(/\r?\n/);
  const redactedLines = lines.map((line) => {
    for (const secret of [config.apiKey, config.token])
      if (secret) line = line.split(secret).join('[redacted]');
    return line;
  });
  let calls = 0;
  const numberedSource = redactedLines.map((line, i) => `${i + 1}: ${line}`).join('\n');
  const extract = async (start: number, end: number, focused = false): Promise<Knowledge> => {
    signal.throwIfAborted();
    if (++calls > config.maxSteps * 2)
      throw new AppError(
        'wiki_budget',
        `Knowledge extraction call budget exhausted for ${source.path}; previous snapshot retained`,
      );
    let result: string;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(config.modelTimeoutMs)]);
    try {
      result = await model.generateKnowledge!(
        focused
          ? `Extraction scope: original source lines ${start}–${end} ONLY. The complete numbered source below is context for headings and inherited table cells. Generate records only for rows or statements in the scope; each record must include at least one citation of non-whitespace source text in the scope. Cite original line numbers, including earlier lines when inheritance requires it. Do not regenerate records outside the scope. Keep summaries and issues concise.\n\n${numberedSource}`
          : numberedSource,
        requestSignal,
      );
      requestSignal.throwIfAborted();
    } catch (error) {
      if (!signal.aborted && requestSignal.aborted)
        throw new AppError(
          'wiki_timeout',
          `Knowledge model request timed out after ${config.modelTimeoutMs} ms for ${source.path}. Increase modelTimeoutMs in configuration or reduce the source size, then run --wiki-update again; previous snapshot retained.`,
          504,
        );
      if (!(error instanceof AppError) || error.code !== 'wiki_output_limit') throw error;
      signal.throwIfAborted();
      if (start >= end)
        throw new AppError(
          'wiki_output_limit',
          `Knowledge output still exceeds the limit for ${source.path}, line ${start}; simplify this source or use a model with a larger output limit`,
        );
      const middle = Math.floor((start + end) / 2);
      const left = await extract(start, middle, true);
      const right = await extract(middle + 1, end, true);
      try {
        return knowledgeSchema.parse({
          summary: [left.summary, right.summary].filter(Boolean).join('\n').slice(0, 2000),
          records: [...left.records, ...right.records],
          issues: [...new Set([...left.issues, ...right.issues])],
        });
      } catch {
        throw new AppError(
          'wiki_limit',
          `Merged knowledge contains duplicate records or exceeds record limits for ${source.path}; previous snapshot retained`,
        );
      }
    }
    signal.throwIfAborted();
    try {
      for (const secret of [config.apiKey, config.token])
        if (secret) result = result.split(secret).join('[redacted]');
      return parseKnowledge(result, redactedLines, focused ? { start, end } : undefined);
    } catch (error) {
      const detail = error instanceof AppError ? error.message : 'Invalid generated knowledge';
      throw new AppError(
        'wiki_generation',
        `Invalid knowledge or source citation for ${source.path}: ${detail}; previous snapshot retained`,
      );
    }
  };
  return extract(1, redactedLines.length);
}
