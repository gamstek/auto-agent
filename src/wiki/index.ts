import { AppError } from '../shared/types';
import { revision } from './knowledge';
import { readSources, sourceRoot } from './sources';
import { loadSnapshot } from './snapshot';
import type { Config } from '../config';
import type { ModelAdapter } from '../shared/types';
import { updateWiki } from './build';

export { KNOWLEDGE_PROMPT } from './prompt';
export { parseKnowledge } from './knowledge';
export { knowledgeSchema } from './knowledge';

export class Wiki {
  constructor(private readonly config: Config) {}
  update(model: ModelAdapter, signal: AbortSignal) {
    return updateWiki(this.config, model, signal);
  }
  query(query: string, limit = 5) {
    return queryWiki(this.config, query, limit);
  }
  async status() {
    try {
      const sources = await readSources(this.config);
      const snapshot = await loadSnapshot(this.config);
      const state = !sources.length
        ? 'empty'
        : !snapshot || snapshot.root !== sourceRoot(this.config)
          ? 'unbuilt'
          : JSON.stringify(sources.map((s) => [s.path, s.hash])) !==
              JSON.stringify(snapshot.sources.map((s) => [s.path, s.hash]))
            ? 'stale'
            : 'ready';
      return {
        state,
        sources: sources.map((source) => source.path),
        records:
          state === 'ready'
            ? snapshot!.sources.reduce((sum, source) => sum + source.knowledge.records.length, 0)
            : 0,
        builtAt: snapshot?.builtAt,
      };
    } catch (error) {
      return {
        state: 'invalid',
        sources: [] as string[],
        records: 0,
        error: error instanceof AppError ? error.message : 'Cannot read wiki sources or snapshot',
      };
    }
  }
}

async function queryWiki(config: Config, query: string, limit = 5): Promise<unknown> {
  if (!query.trim() || query.length > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new AppError('wiki_query', 'Query must be 1–1000 characters and limit 1–10');
  const sources = await readSources(config);
  const snapshot = await loadSnapshot(config);
  if (!snapshot || snapshot.root !== sourceRoot(config))
    throw new AppError('wiki_unbuilt', 'Run --wiki-update before querying knowledge');
  if (
    JSON.stringify(sources.map((s) => [s.path, s.hash])) !==
    JSON.stringify(snapshot.sources.map((s) => [s.path, s.hash]))
  )
    throw new AppError('wiki_stale', 'Sources changed; run --wiki-update before using knowledge');
  const normalized = query.toLowerCase().normalize('NFKC');
  const matches = snapshot.sources
    .flatMap((source) =>
      source.knowledge.records.map((record) => {
        const terms = [
          ...new Set(record.terms.map((term) => term.toLowerCase().normalize('NFKC'))),
        ];
        const score = terms.reduce(
          (sum, term) => sum + (normalized.includes(term) ? term.length : 0),
          0,
        );
        return {
          ...record,
          score,
          source: source.path,
          sourceHash: source.hash,
          sourceIssues: source.knowledge.issues,
        };
      }),
    )
    .filter((record) => record.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const results: typeof matches = [];
  for (const match of matches) {
    if (Buffer.byteLength(JSON.stringify([...results, match])) > config.resourceLimitBytes) break;
    results.push(match);
  }
  return {
    builtAt: snapshot.builtAt,
    revision,
    results,
    truncated: results.length < matches.length,
    status: results.length ? 'recommendations_only' : 'no_match',
    warning:
      'Source citations are checked for existence, not semantic truth. Preserve ranges; resolve missing or conflicting facts before executable configuration. No instrument was configured or started.',
  };
}
