import { AppError } from '../shared/types';
import { revision } from './knowledge';
import { readSources, sourceRoot } from './sources';
import { loadSnapshot } from './snapshot';
import type { Config } from '../config';
import type { ModelAdapter } from '../shared/types';
import { updateWiki } from './build';
import { createKeywordSearch, compareSearchResults } from './search';

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
  const records = snapshot.sources.flatMap((source) =>
    source.knowledge.records.map((record) => ({
      ...record,
      source: source.path,
      sourceHash: source.hash,
      sourceIssues: source.knowledge.issues,
    })),
  );
  const search = createKeywordSearch(query);
  const ranked = records
    .map((record) => ({ ...record, score: search.score(record) }))
    .filter((record) => record.score > 0)
    .sort(compareSearchResults);
  const matches = ranked
    .slice(0, limit)
    .map((record) => ({ ...record, match: search.match(record) }));
  const responseFor = (results: typeof matches) => ({
    builtAt: snapshot.builtAt,
    revision,
    results,
    truncated: results.length < ranked.length,
    indexedRecords: records.length,
    matchedRecords: ranked.length,
    queryTruncated: search.queryTruncated,
    mode: 'keyword',
    status: results.length ? 'recommendations_only' : matches.length ? 'output_limit' : 'no_match',
    ...(!results.length
      ? {
          availableTerms: [...new Set(records.flatMap((record) => record.terms))].slice(0, 24),
          hint: matches.length
            ? 'Matching records exceed resourceLimitBytes; request a smaller result or ask the operator to increase the resource limit. No record was returned.'
            : 'No keyword match in record titles, terms, fact labels/values or source filenames. Choose a relevant material or method from availableTerms; do not invent missing recommendations.',
        }
      : {}),
    warning:
      'Source citations are checked for existence, not semantic truth. Preserve ranges; resolve missing or conflicting facts before executable configuration. No instrument was configured or started.',
  });
  const fits = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value)) <= config.resourceLimitBytes;
  const results: typeof matches = [];
  for (const match of matches) {
    if (!fits(responseFor([...results, match]))) break;
    results.push(match);
  }
  const response = responseFor(results);
  while (!fits(response) && response.availableTerms?.length) {
    response.availableTerms.pop();
    response.truncated = true;
  }
  if (!fits(response)) {
    delete response.hint;
    response.truncated = true;
  }
  if (!fits(response)) delete response.availableTerms;
  if (!fits(response)) {
    throw new AppError(
      'wiki_output_limit',
      'resourceLimitBytes is too small for wiki response metadata and its evidence warning; increase the resource limit. No record was returned.',
    );
  }
  return response;
}
