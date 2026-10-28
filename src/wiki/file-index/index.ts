import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Config } from '../../config';
import { AppError } from '../../shared/types';
import { normalizeSearch } from '../search';
import { extract, searchBody, tokensFor, chooseEvidence } from './extract';
import {
  INDEX_REVISION,
  MAX_FILES,
  MAX_FILE_BYTES,
  recordSchema,
  searchSchema,
  readSchema,
  warning as evidenceWarning,
  type IndexedSource,
} from './schema';
export {
  filtersSchema,
  searchSchema,
  readSchema,
  searchResultSchema,
  readResultSchema,
} from './schema';

const updating = new WeakSet<Database>();
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const rootId = (root: string) => hash(resolve(root));
const within = (root: string, file: string) => {
  const part = relative(root, file);
  return (
    part === '' ||
    (!isAbsolute(part) &&
      part !== '..' &&
      !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')))
  );
};
interface Row {
  id: string;
  data: string;
  body: string;
  hash: string | null;
}
export class SourceIndex {
  constructor(
    private config: Pick<Config, 'wikiIndexRoots' | 'dataDir' | 'resourceLimitBytes'>,
    private db: Database,
    private readonly snapshot = false,
  ) {}
  private fingerprint() {
    return hash(
      JSON.stringify({
        revision: INDEX_REVISION,
        roots: this.config.wikiIndexRoots.map((root) => resolve(root)).sort(),
      }),
    );
  }
  status() {
    const meta = this.db
      .query<{ fingerprint: string; indexedAt: number }, []>(
        'SELECT fingerprint, indexedAt FROM wiki_index_meta WHERE id = 1',
      )
      .get();
    const counts = this.db
      .query<
        { records: number; parsed: number; partial: number; unsupported: number; errors: number },
        []
      >(
        `SELECT count(*) AS records, coalesce(sum(state='parsed'),0) AS parsed, coalesce(sum(state='partial'),0) AS partial, coalesce(sum(state='unsupported'),0) AS unsupported, coalesce(sum(state='error'),0) AS errors FROM wiki_files`,
      )
      .get()!;
    return {
      state:
        this.snapshot && meta
          ? 'ready'
          : !this.config.wikiIndexRoots.length
            ? 'empty'
            : !meta
              ? 'unbuilt'
              : meta.fingerprint !== this.fingerprint()
                ? 'stale'
                : 'ready',
      roots: this.config.wikiIndexRoots,
      indexedAt: meta?.indexedAt ?? null,
      ...counts,
      updating: updating.has(this.db),
      mode: this.snapshot ? 'readonly-snapshot' : 'local-index',
    };
  }
  private ready() {
    const status = this.status();
    if (status.state !== 'ready')
      throw new AppError(
        'wiki_index_unbuilt',
        'Configure wikiIndexRoots and explicitly run --wiki-index before searching source files.',
      );
    return status.indexedAt!;
  }
  private async source(root: string, path: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new AppError(
        'wiki_index_path',
        'Configured Wiki source root is no longer a regular directory',
      );
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !within(await realpath(root), await realpath(path))
    )
      throw new AppError('wiki_index_path', 'Wiki source is not a confined regular file');
    if (stat.size > MAX_FILE_BYTES) return { stat, bytes: null };
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const opened = await file.stat();
      if (
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev ||
        opened.size !== stat.size ||
        !within(await realpath(root), await realpath(path))
      )
        throw new AppError('wiki_index_changed', 'Wiki source changed while opening');
      const bytes = new Uint8Array(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const result = await file.read(
          bytes,
          offset,
          Math.min(1024 * 1024, bytes.length - offset),
          offset,
        );
        if (!result.bytesRead) break;
        offset += result.bytesRead;
      }
      const after = await file.stat();
      if (offset !== bytes.length || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs)
        throw new AppError('wiki_index_changed', 'Wiki source changed while reading');
      return { stat: after, bytes };
    } finally {
      await file.close();
    }
  }
  async update(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.snapshot) {
      const status = this.status();
      return {
        indexedAt: this.ready(),
        records: status.records,
        reused: status.records,
        rebuilt: 0,
        skippedLinks: 0,
        errors: status.errors,
      };
    }
    if (updating.has(this.db))
      throw new AppError('wiki_index_busy', 'Wiki source index update already running', 409);
    if (!this.config.wikiIndexRoots.length)
      throw new AppError(
        'wiki_index_roots',
        'Configure wikiIndexRoots before indexing source files',
      );
    updating.add(this.db);
    try {
      const entries: { root: string; path: string; relative: string }[] = [];
      const reuseAllowed = this.status().state === 'ready';
      const seen = new Set<string>();
      let skippedLinks = 0;
      const scan = async (root: string, directory: string) => {
        signal.throwIfAborted();
        if (!within(root, await realpath(directory)))
          throw new AppError('wiki_index_path', 'Wiki source directory escapes its root');
        for (const child of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          signal.throwIfAborted();
          const path = join(directory, child.name);
          if (within(resolve(this.config.dataDir), resolve(path)) || child.name === '.git')
            continue;
          if (child.isSymbolicLink()) {
            skippedLinks++;
            continue;
          }
          if (child.isDirectory()) await scan(root, path);
          else if (child.isFile() && /\.(sam|smp)$/i.test(child.name) && !seen.has(path)) {
            seen.add(path);
            entries.push({ root, path, relative: relative(root, path).replaceAll('\\', '/') });
            if (entries.length > MAX_FILES)
              throw new AppError(
                'wiki_index_limit',
                `Wiki file index exceeds ${MAX_FILES} files; previous index retained`,
              );
          }
        }
      };
      for (const configured of this.config.wikiIndexRoots) {
        const stat = await lstat(configured).catch(() => {
          throw new AppError(
            'wiki_index_roots',
            'A configured Wiki source root is unavailable; previous index retained',
          );
        });
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new AppError(
            'wiki_index_roots',
            'Each Wiki source root must be a regular directory, not a symbolic link',
          );
        // Keep configured-root IDs stable while confinement uses the canonical path.
        await scan(configured, configured);
      }
      const previous = new Map(
        this.db
          .query<Row, []>("SELECT id, data, body, hash FROM wiki_files WHERE kind='sam'")
          .all()
          .map((row) => [row.id, row]),
      );
      const records: { record: IndexedSource; body: string }[] = [];
      let snapshotBytes = 0;
      const append = (record: IndexedSource, body: string) => {
        snapshotBytes += Buffer.byteLength(JSON.stringify(record)) + Buffer.byteLength(body);
        if (snapshotBytes > 64 * 1024 * 1024)
          throw new AppError(
            'wiki_index_limit',
            'Extracted Wiki source snapshot exceeds 64 MiB; previous index retained',
          );
        records.push({ record, body });
      };
      let reused = 0,
        rebuilt = 0;
      for (const entry of entries) {
        signal.throwIfAborted();
        const kind = 'sam' as const;
        const id = hash(rootId(entry.root) + '\0' + entry.relative);
        let record: IndexedSource = {
          id,
          rootId: rootId(entry.root),
          path: entry.relative,
          sha256: null,
          bytes: 0,
          kind,
          state: 'unsupported',
          metadata: {
            materialHint: entry.relative.split('/').length > 1 ? entry.relative.split('/')[0]! : '',
            materialBasis: 'directory-hint',
            product: null,
            productBasis: 'unknown',
            gas: null,
            analysisType: null,
            pressureMode: null,
            clientVersion: null,
            temperatureK: null,
            fileState: null,
            sampleName: null,
            uuid: null,
          },
          issues: [],
          evidence: [],
          configuration: null,
        };
        let extractionSignal: AbortSignal | undefined;
        try {
          const { stat, bytes } = await this.source(entry.root, entry.path, signal);
          record.bytes = stat.size;
          if (!bytes) {
            record.issues.push(
              !bytes
                ? 'FILE_LIMIT: file exceeds 32 MiB; metadata only'
                : 'UNSUPPORTED_FORMAT: metadata only',
            );
          } else {
            record.sha256 = hash(bytes);
            const old = previous.get(id);
            if (reuseAllowed && old?.hash === record.sha256) {
              let value: unknown;
              try {
                value = JSON.parse(old.data);
              } catch {
                value = null;
              }
              const cached = recordSchema.safeParse(value);
              if (cached.success && cached.data.state !== 'error') {
                append(cached.data, old.body);
                reused++;
                continue;
              }
            }
            extractionSignal = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
            record = await extract(record, entry.path, bytes, extractionSignal);
          }
        } catch (error) {
          signal.throwIfAborted();
          if (
            error instanceof AppError &&
            ['wiki_index_changed', 'wiki_index_path', 'wiki_index_limit'].includes(error.code)
          )
            throw error;
          const code = extractionSignal?.aborted
            ? 'EXTRACTION_TIMEOUT'
            : error && typeof error === 'object' && 'publicCode' in error
              ? String(error.publicCode)
              : 'EXTRACTION_FAILED';
          record.state = code === 'UNSUPPORTED_FORMAT' ? 'unsupported' : 'error';
          record.configuration = null;
          record.evidence = [];
          record.issues.push(code);
        }
        rebuilt++;
        append(recordSchema.parse(record), searchBody(record));
      }
      signal.throwIfAborted();
      const indexedAt = Date.now();
      this.db
        .transaction(() => {
          this.db.exec('DELETE FROM wiki_file_search; DELETE FROM wiki_files;');
          const insert = this.db.prepare(
            'INSERT INTO wiki_files (id, rootId, path, directory, hash, kind, state, material, product, gas, analysisType, pressureMode, clientVersion, temperatureK, data, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          );
          const index = this.db.prepare('INSERT INTO wiki_file_search (id, body) VALUES (?, ?)');
          try {
            for (const { record: r, body } of records) {
              signal.throwIfAborted();
              const m = r.metadata;
              insert.run(
                r.id,
                r.rootId,
                r.path,
                dirname(r.path),
                r.sha256,
                r.kind,
                r.state,
                normalizeSearch(m.materialHint),
                m.product,
                m.gas === null ? null : normalizeSearch(m.gas),
                m.analysisType,
                m.pressureMode,
                m.clientVersion,
                m.temperatureK,
                JSON.stringify(r),
                body,
              );
              index.run(r.id, body);
            }
            this.db
              .query('INSERT OR REPLACE INTO wiki_index_meta VALUES (1, ?, ?)')
              .run(this.fingerprint(), indexedAt);
          } finally {
            insert.finalize();
            index.finalize();
          }
        })
        .immediate();
      return {
        indexedAt,
        records: records.length,
        reused,
        rebuilt,
        skippedLinks,
        errors: records.filter((r) => r.record.state === 'error').length,
      };
    } finally {
      updating.delete(this.db);
    }
  }
  search(raw: unknown) {
    const warning = this.snapshot
      ? `${evidenceWarning} Read-only template snapshot: original files are not reverified.`
      : evidenceWarning;
    const parsed = searchSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError('wiki_index_query', 'Invalid source query, filters or limit');
    const input = parsed.data;
    const indexedAt = this.ready();
    const where: string[] = [],
      args: (string | number)[] = [];
    const tokens = tokensFor(input.query);
    if (input.query && !tokens.length) {
      const empty = { indexedAt, results: [], matchedRecords: 0, truncated: false, warning };
      if (Buffer.byteLength(JSON.stringify(empty)) > this.config.resourceLimitBytes)
        throw new AppError(
          'wiki_index_output_limit',
          'Wiki source response metadata exceeds resourceLimitBytes',
        );
      return empty;
    }
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
    const from = match
      ? 'wiki_file_search JOIN wiki_files f ON f.id=wiki_file_search.id'
      : 'wiki_files f';
    if (match) {
      where.push('wiki_file_search MATCH ?');
      args.push(match);
    }
    for (const [field, value] of Object.entries(input.filters)) {
      if (field === 'temperatureMinK') {
        where.push('f.temperatureK >= ?');
        args.push(value as number);
      } else if (field === 'temperatureMaxK') {
        where.push('f.temperatureK <= ?');
        args.push(value as number);
      } else {
        where.push(`f.${field === 'material' ? 'material' : field} = ?`);
        args.push(
          field === 'material' || field === 'gas' ? normalizeSearch(String(value)) : String(value),
        );
      }
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const matchedRecords = this.db
      .query<{ count: number }, any[]>(
        `SELECT count(DISTINCT coalesce(f.hash, f.id)) AS count FROM ${from}${clause}`,
      )
      .get(...args)!.count;
    const statement = this.db.prepare<Row, any[]>(
      `SELECT f.id, f.data, '' AS body, f.hash FROM ${from}${clause} ORDER BY ${match ? 'bm25(wiki_file_search),' : ''} f.id`,
    );
    const results: any[] = [],
      hashes = new Set<string>();
    let truncated = false;
    try {
      for (const row of statement.iterate(...args)) {
        const record = recordSchema.parse(JSON.parse(row.data));
        const key = record.sha256 ?? record.id;
        if (hashes.has(key)) continue;
        hashes.add(key);
        const { evidence: _e, configuration: _c, ...summary } = record;
        const candidate = { ...summary, sourceVerified: false as const };
        const response = {
          indexedAt,
          results: [...results, candidate],
          matchedRecords,
          truncated: false,
          warning,
        };
        if (Buffer.byteLength(JSON.stringify(response)) > this.config.resourceLimitBytes) {
          truncated = true;
          break;
        }
        results.push(candidate);
        if (results.length === input.limit) break;
      }
    } finally {
      statement.finalize();
    }
    const response = {
      indexedAt,
      results,
      matchedRecords,
      truncated: truncated || matchedRecords > results.length,
      warning,
    };
    if (Buffer.byteLength(JSON.stringify(response)) > this.config.resourceLimitBytes)
      throw new AppError(
        'wiki_index_output_limit',
        'Wiki source response metadata exceeds resourceLimitBytes',
      );
    return response;
  }
  async read(raw: unknown, signal: AbortSignal = new AbortController().signal) {
    signal.throwIfAborted();
    const warning = this.snapshot
      ? `${evidenceWarning} Read-only template snapshot: original files are not reverified.`
      : evidenceWarning;
    const parsed = readSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError('wiki_index_query', 'Invalid source ID or evidence query');
    const input = parsed.data,
      indexedAt = this.ready();
    const row = this.db
      .query<Row, [string]>('SELECT id, data, body, hash FROM wiki_files WHERE id=?')
      .get(input.id);
    if (!row) throw new AppError('wiki_source_not_found', 'Wiki source record not found', 404);
    const record = recordSchema.parse(JSON.parse(row.data));
    let sourceVerified = false;
    if (this.snapshot) {
      if (!record.sha256)
        throw new AppError('wiki_snapshot', 'Template snapshot is missing a source hash');
      record.origin = {
        path: record.path,
        sha256: record.sha256,
        bytes: record.bytes,
        kind: 'sam',
        indexedAt,
        sourceVerified: false,
      };
    } else {
      const root = this.config.wikiIndexRoots.find((root) => rootId(root) === record.rootId);
      if (!root)
        throw new AppError('wiki_index_stale', 'Wiki source roots changed; rebuild the index');
      const path = resolve(root, record.path);
      if (!within(root, path))
        throw new AppError('wiki_index_path', 'Wiki source path escapes its root');
      const { bytes, stat } = await this.source(root, path, signal).catch((error) => {
        if (error instanceof AppError) throw error;
        throw new AppError(
          'wiki_index_stale',
          'Template is unavailable; explicitly rebuild the index',
        );
      });
      sourceVerified = Boolean(bytes && record.sha256 && hash(bytes) === record.sha256);
      if ((record.sha256 && !sourceVerified) || stat.size !== record.bytes)
        throw new AppError(
          'wiki_index_stale',
          'Template changed; explicitly rebuild before reading evidence',
        );
    }
    const selected = chooseEvidence(record.evidence, input.query, input.maxEvidence);
    const response = {
      indexedAt,
      record: { ...record, evidence: selected },
      sourceVerified,
      evidenceTruncated: selected.length < record.evidence.length,
      warning,
    };
    while (
      Buffer.byteLength(JSON.stringify(response)) > this.config.resourceLimitBytes &&
      response.record.evidence.length
    ) {
      response.record.evidence.pop();
      response.evidenceTruncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(response)) > this.config.resourceLimitBytes)
      throw new AppError(
        'wiki_index_output_limit',
        'Wiki source configuration exceeds resourceLimitBytes; increase the configured resource limit',
      );
    return response;
  }
}
