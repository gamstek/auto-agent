import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import {
  ParserRegistry,
  WikiError,
  sourceSchema,
  searchSchema,
  readSchema,
  type SourceInput,
  type Source,
  type ParsedDocument,
  type BuildResult,
  type Reference,
  type SearchInput,
  type ReadInput,
  type Attributes,
  type Locator,
} from './contracts';
import { hash, scan, readSnapshot } from './files';
import { materializeBundles, exportBundle, type PublishedBundle } from './bundles';

type IndexedDocument = {
  id: string;
  sourceId: string;
  path: string;
  bytes: number;
  state: 'parsed' | 'unsupported';
  code: string | null;
  versionId: string | null;
  representationId: string | null;
  sha256: string | null;
  parserId: string | null;
  parserVersion: string | null;
  parsed?: ParsedDocument;
};
type Hit = {
  documentId: string;
  sourceId: string;
  collection: string;
  path: string;
  title: string;
  mediaType: string;
  versionId: string;
  representationId: string;
  unitId: string;
  text: string;
  locator: string;
  attributes: string;
  sha256: string;
  parserId: string;
  parserVersion: string;
  observedAt: number;
};

/** Deterministic local search tokens, including CJK bigrams; no model or network. */
export function searchTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const word of text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      for (let index = 0; index < chars.length; index++) {
        tokens.add(chars[index]!);
        if (index + 1 < chars.length) tokens.add(chars[index]! + chars[index + 1]!);
      }
    } else tokens.add(word.slice(0, 128));
  }
  return [...tokens];
}
const bodyFor = (text: string) => searchTokens(text).join(' ');
const parsedJson = <T>(value: string): T => JSON.parse(value) as T;

export class WikiLibrary {
  private db!: Database;
  private owner: Database;
  private active?: { controller: AbortController; done: Promise<BuildResult> };
  private closed = false;
  private closing = false;
  private readonly directory: string;
  constructor(
    databasePath: string,
    readonly registry: ParserRegistry,
    bundles: readonly PublishedBundle[] = [],
  ) {
    const path = resolve(databasePath);
    this.directory = dirname(path);
    mkdirSync(this.directory, { recursive: true });
    this.owner = new Database(path + '.owner.sqlite', { create: true });
    try {
      this.owner.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch {
      this.owner.close();
      throw new WikiError('wiki_owned', 'Another process owns this Wiki database', 409);
    }
    try {
      this.db = new Database(path, { create: true });
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
      const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!
        .user_version;
      if (version !== 0 && version !== 3)
        throw new WikiError('wiki_revision', 'Wiki database schema does not match the current protocol');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS wiki_meta (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL, publishedAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, collection TEXT NOT NULL, config TEXT NOT NULL, active INTEGER NOT NULL,bundleId TEXT);
        CREATE TABLE IF NOT EXISTS bundles (id TEXT PRIMARY KEY,digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, sourceId TEXT NOT NULL REFERENCES sources(id), path TEXT NOT NULL,
          bytes INTEGER NOT NULL, state TEXT NOT NULL, code TEXT, versionId TEXT, representationId TEXT, observedAt INTEGER NOT NULL, active INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS versions (id TEXT PRIMARY KEY, documentId TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS representations (id TEXT PRIMARY KEY, versionId TEXT NOT NULL REFERENCES versions(id), parserId TEXT NOT NULL,
          parserVersion TEXT NOT NULL, title TEXT NOT NULL, mediaType TEXT NOT NULL, attributes TEXT NOT NULL, issues TEXT NOT NULL, unitCount INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS units (id TEXT PRIMARY KEY, representationId TEXT NOT NULL REFERENCES representations(id), ordinal INTEGER NOT NULL,
          text TEXT NOT NULL, locator TEXT NOT NULL, data TEXT, UNIQUE(representationId,ordinal));
        CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(unitId UNINDEXED, body, tokenize='unicode61');
        CREATE TABLE IF NOT EXISTS builds (id TEXT PRIMARY KEY, state TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, code TEXT);
        CREATE INDEX IF NOT EXISTS documents_source ON documents(sourceId,active);
        CREATE INDEX IF NOT EXISTS units_representation ON units(representationId,ordinal);
        PRAGMA user_version=3;
      `);
      this.db
        .query(
          "UPDATE builds SET state='interrupted',finishedAt=?,code='process_interrupted' WHERE state='running'",
        )
        .run(Date.now());
      materializeBundles(this.db, bundles);
    } catch (error) {
      this.db!?.close();
      this.owner.close();
      throw error;
    }
  }
  private ensureOpen() {
    if (this.closed || this.closing)
      throw new WikiError('wiki_closed', 'Wiki library is closed', 503);
  }
  get building() {
    return !!this.active;
  }
  exportBundle(output: string): void {
    this.ensureOpen();
    if (this.active) throw new WikiError('wiki_busy', 'Cannot publish while indexing', 409);
    exportBundle(this.db, output);
  }
  private generation() {
    return this.db
      .query<{ generation: string; publishedAt: number }, []>(
        'SELECT generation,publishedAt FROM wiki_meta WHERE id=1',
      )
      .get();
  }
  catalog() {
    this.ensureOpen();
    return {
      ...this.generation(),
      building: !!this.active,
      sources: this.db
        .query<
          {
            id: string;
            collection: string;
            documents: number;
            parsed: number;
            unsupported: number;
          },
          []
        >(
          `SELECT s.id,s.collection,count(d.id) AS documents,coalesce(sum(d.state='parsed'),0) AS parsed,
          coalesce(sum(d.state='unsupported'),0) AS unsupported FROM sources s LEFT JOIN documents d ON d.sourceId=s.id AND d.active=1 WHERE s.active=1 GROUP BY s.id ORDER BY s.id`,
        )
        .all(),
      parsers: this.registry.parsers.map(({ id, version, fields }) => ({ id, version, fields })),
      lastBuild: this.db
        .query('SELECT id,state,startedAt,finishedAt,code FROM builds ORDER BY rowid DESC LIMIT 1')
        .get(),
    };
  }
  documents(sourceId?: string, offset = 0, limit = 100) {
    this.ensureOpen();
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new WikiError('wiki_query', 'Invalid document page');
    return this.db
      .query(
        'SELECT id,sourceId,path,bytes,state,code,versionId,representationId,observedAt FROM documents WHERE active=1 AND (? IS NULL OR sourceId=?) ORDER BY sourceId,path LIMIT ? OFFSET ?',
      )
      .all(sourceId ?? null, sourceId ?? null, limit, offset);
  }
  lint() {
    this.ensureOpen();
    const broken = this.db
      .query<{ representationId: string; expected: number; units: number; indexed: number }, []>(
        `SELECT r.id AS representationId,r.unitCount AS expected,
        (SELECT count(*) FROM units u WHERE u.representationId=r.id) AS units,
        (SELECT count(*) FROM wiki_fts f JOIN units u ON u.id=f.unitId WHERE u.representationId=r.id) AS indexed
       FROM representations r WHERE expected!=units OR expected!=indexed ORDER BY r.id LIMIT 101`,
      )
      .all();
    return {
      scope: 'stored-representations' as const,
      healthy: broken.length === 0,
      issues: broken.slice(0, 100).map((row) => ({ code: 'derived_content_incomplete', ...row })),
      truncated: broken.length > 100,
      sourceVerified: false as const,
    };
  }
  build(inputs: readonly SourceInput[], signal: AbortSignal): Promise<BuildResult> {
    this.ensureOpen();
    if (this.active) throw new WikiError('wiki_busy', 'Wiki build already running', 409);
    const sources = inputs.map((input) => sourceSchema.parse(input));
    if (sources.length > 100 || new Set(sources.map((source) => source.id)).size !== sources.length)
      throw new WikiError('wiki_sources', 'Too many or duplicate source IDs');
    for (const source of sources) {
      if (this.db.query('SELECT id FROM sources WHERE id=? AND bundleId IS NOT NULL').get(source.id))
        throw new WikiError('wiki_source_conflict', 'Source ID is reserved by a published bundle');
      if (!isAbsolute(source.path))
        throw new WikiError('wiki_source_path', 'Source paths must be resolved by the application');
      const part = relative(source.path, this.directory);
      if (
        source.type === 'directory' &&
        (part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)))
      )
        throw new WikiError(
          'wiki_source_path',
          'Wiki storage must be outside indexed source directories',
        );
    }
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, signal]);
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO builds VALUES (?,'running',?,NULL,NULL)").run(id, Date.now());
    const done = Promise.resolve()
      .then(() => this.buildSources(sources, combined, id))
      .catch((error) => {
        const code = combined.aborted
          ? 'cancelled'
          : error instanceof WikiError
            ? error.code
            : 'wiki_build_failed';
        this.db
          .query('UPDATE builds SET state=?,finishedAt=?,code=? WHERE id=?')
          .run(combined.aborted ? 'cancelled' : 'failed', Date.now(), code, id);
        if (combined.aborted)
          throw new WikiError('cancelled', 'Wiki build cancelled; previous index retained', 409);
        if (error instanceof WikiError) throw error;
        throw new WikiError('wiki_build_failed', 'Wiki build failed; previous index retained');
      })
      .finally(() => {
        this.active = undefined;
      });
    this.active = { controller, done };
    return done;
  }
  private async buildSources(
    sources: Source[],
    signal: AbortSignal,
    buildId: string,
  ): Promise<BuildResult> {
    signal.throwIfAborted();
    const pending: IndexedDocument[] = [];
    let reused = 0,
      rebuilt = 0,
      totalBytes = 0;
    for (const source of sources) {
      const files = await scan(source, signal);
      for (const file of files) {
        signal.throwIfAborted();
        if (pending.length >= 10000)
          throw new WikiError('wiki_limit', 'Library exceeds 10,000 documents');
        const id = hash(JSON.stringify([source.id, file.relativePath]));
        const parser = this.registry.select(file.relativePath);
        const document: IndexedDocument = {
          id,
          sourceId: source.id,
          path: file.relativePath,
          bytes: file.bytes,
          state: 'unsupported',
          code: 'unsupported_format',
          versionId: null,
          representationId: null,
          sha256: null,
          parserId: null,
          parserVersion: null,
        };
        if (parser) {
          const snapshot = await readSnapshot(file, signal);
          document.bytes = snapshot.bytes.byteLength;
          document.sha256 = snapshot.sha256;
          document.versionId = hash(JSON.stringify([id, snapshot.sha256]));
          document.representationId = hash(
            JSON.stringify([document.versionId, parser.id, parser.version, 'units-v1']),
          );
          document.parserId = parser.id;
          document.parserVersion = parser.version;
          const cached = this.db
            .query(
              `SELECT id FROM representations r WHERE id=?
            AND unitCount=(SELECT count(*) FROM units u WHERE u.representationId=r.id)
            AND unitCount=(SELECT count(*) FROM wiki_fts f JOIN units u ON u.id=f.unitId WHERE u.representationId=r.id)`,
            )
            .get(document.representationId);
          if (cached) {
            document.state = 'parsed';
            document.code = null;
            reused++;
          } else {
            try {
              const parsed = await parser.parse(snapshot, { signal });
              signal.throwIfAborted();
              this.registry.validate(parser, parsed);
              totalBytes += Buffer.byteLength(JSON.stringify(parsed));
              if (totalBytes > 128 * 1024 * 1024)
                throw new WikiError('wiki_limit', 'Build exceeds 128 MiB of parsed content');
              document.parsed = parsed;
              document.state = 'parsed';
              document.code = null;
              rebuilt++;
            } catch (error) {
              if (!(error instanceof WikiError) || error.code !== 'unsupported_format') throw error;
              document.code = error.code;
              document.representationId = null;
            }
          }
        }
        pending.push(document);
      }
    }
    signal.throwIfAborted();
    const generation = crypto.randomUUID();
    const now = Date.now();
    const nextIds = new Set(pending.map((doc) => doc.id));
    const removed = this.db
      .query<{ id: string }, []>('SELECT id FROM documents WHERE active=1 AND sourceId IN (SELECT id FROM sources WHERE bundleId IS NULL)')
      .all()
      .filter((doc) => !nextIds.has(doc.id)).length;
    this.db
      .transaction(() => {
        this.db.exec('UPDATE documents SET active=0 WHERE sourceId IN (SELECT id FROM sources WHERE bundleId IS NULL); UPDATE sources SET active=0 WHERE bundleId IS NULL;');
        for (const source of sources)
          this.db
            .query(
              'INSERT INTO sources VALUES (?,?,?,1,NULL) ON CONFLICT(id) DO UPDATE SET collection=excluded.collection,config=excluded.config,active=1',
            )
            .run(source.id, source.collection, JSON.stringify(source));
        for (const doc of pending) {
          signal.throwIfAborted();
          if (doc.versionId)
            this.db
              .query('INSERT OR IGNORE INTO versions VALUES (?,?,?,?)')
              .run(doc.versionId, doc.id, doc.sha256, doc.bytes);
          if (doc.parsed) {
            const parsed = doc.parsed;
            this.db
              .query(
                'DELETE FROM wiki_fts WHERE unitId IN (SELECT id FROM units WHERE representationId=?)',
              )
              .run(doc.representationId);
            this.db.query('DELETE FROM units WHERE representationId=?').run(doc.representationId);
            this.db.query('DELETE FROM representations WHERE id=?').run(doc.representationId);
            this.db
              .query('INSERT INTO representations VALUES (?,?,?,?,?,?,?,?,?)')
              .run(
                doc.representationId,
                doc.versionId,
                doc.parserId,
                doc.parserVersion,
                parsed.title,
                parsed.mediaType,
                JSON.stringify(parsed.attributes),
                JSON.stringify(parsed.issues),
                parsed.units.length,
              );
            for (const [ordinal, unit] of parsed.units.entries()) {
              const unitId = hash(JSON.stringify([doc.representationId, ordinal]));
              this.db
                .query('INSERT INTO units VALUES (?,?,?,?,?,?)')
                .run(
                  unitId,
                  doc.representationId,
                  ordinal,
                  unit.text,
                  JSON.stringify(unit.locator),
                  unit.data === undefined ? null : JSON.stringify(unit.data),
                );
              this.db
                .query('INSERT INTO wiki_fts VALUES (?,?)')
                .run(
                  unitId,
                  bodyFor(
                    `${doc.path}\n${parsed.title}\n${JSON.stringify(parsed.attributes)}\n${unit.text}`,
                  ),
                );
            }
          }
          this.db
            .query(
              `INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET
          sourceId=excluded.sourceId,path=excluded.path,bytes=excluded.bytes,state=excluded.state,code=excluded.code,
          versionId=excluded.versionId,representationId=excluded.representationId,observedAt=excluded.observedAt,active=1`,
            )
            .run(
              doc.id,
              doc.sourceId,
              doc.path,
              doc.bytes,
              doc.state,
              doc.code,
              doc.versionId,
              doc.representationId,
              now,
            );
        }
        this.db
          .query(
            'INSERT INTO wiki_meta VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,publishedAt=excluded.publishedAt',
          )
          .run(generation, now);
        this.db
          .query("UPDATE builds SET state='completed',finishedAt=? WHERE id=?")
          .run(now, buildId);
      })
      .immediate();
    return {
      generation,
      documents: pending.length,
      parsed: pending.filter((doc) => doc.state === 'parsed').length,
      unsupported: pending.filter((doc) => doc.state === 'unsupported').length,
      reused,
      rebuilt,
      removed,
    };
  }
  search(raw: SearchInput) {
    this.ensureOpen();
    const input = searchSchema.parse(raw);
    const meta = this.generation();
    if (!meta) throw new WikiError('wiki_unbuilt', 'Build the library before searching');
    const fingerprint = hash(JSON.stringify({ ...input, cursor: undefined }));
    let offset = 0;
    if (input.cursor) {
      let cursor: { generation: string; fingerprint: string; offset: number };
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      } catch {
        throw new WikiError('wiki_cursor', 'Invalid search cursor');
      }
      if (
        cursor.generation !== meta.generation ||
        cursor.fingerprint !== fingerprint ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0
      )
        throw new WikiError(
          'wiki_cursor',
          'Search changed or the cursor is invalid; restart the search',
          409,
        );
      offset = cursor.offset;
    }
    const params: (string | number)[] = [];
    const tokens = searchTokens(input.query);
    if (input.query && !tokens.length)
      return { ...meta, results: [], nextCursor: null, sourceVerified: false as const };
    if (tokens.length > 128)
      throw new WikiError('wiki_query_limit', 'Search query has too many tokens');
    let where = "d.active=1 AND d.state='parsed'";
    const match = tokens.length
      ? tokens.map((token) => '"' + token.replaceAll('"', '""') + '"').join(' AND ')
      : '';
    if (match) {
      where += ' AND wiki_fts MATCH ?';
      params.push(match);
    } else where += ' AND u.ordinal=0';
    if (input.sourceId) {
      where += ' AND d.sourceId=?';
      params.push(input.sourceId);
    }
    if (input.collection) {
      where += ' AND s.collection=?';
      params.push(input.collection);
    }
    for (const filter of input.filters) {
      const field = this.registry.fields.get(filter.field);
      if (
        !field ||
        typeof filter.value !== field.type ||
        (filter.op !== 'eq' && field.type !== 'number')
      )
        throw new WikiError(
          'wiki_filter',
          'Unknown field, incompatible value or unsupported comparison',
        );
      where += ` AND EXISTS(SELECT 1 FROM json_each(r.attributes) a WHERE a.key=? AND a.value ${filter.op === 'eq' ? '=' : filter.op === 'gte' ? '>=' : '<='} ?)`;
      params.push(
        filter.field,
        typeof filter.value === 'boolean' ? Number(filter.value) : filter.value,
      );
    }
    const rows = this.db
      .query<Hit, (string | number)[]>(
        `WITH hits AS MATERIALIZED (SELECT d.id AS documentId,d.sourceId,s.collection,d.path,r.title,r.mediaType,d.versionId,d.representationId,
      u.id AS unitId,u.text,u.locator,r.attributes,v.sha256,r.parserId,r.parserVersion,d.observedAt,u.ordinal,${match ? 'bm25(wiki_fts)' : '0'} AS score
      FROM documents d JOIN sources s ON s.id=d.sourceId JOIN representations r ON r.id=d.representationId
      JOIN versions v ON v.id=d.versionId JOIN units u ON u.representationId=r.id ${match ? 'JOIN wiki_fts ON wiki_fts.unitId=u.id' : ''}
      WHERE ${where}) SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY documentId ORDER BY score,ordinal) AS position FROM hits)
      WHERE position=1 ORDER BY score,documentId LIMIT ? OFFSET ?`,
      )
      .all(...params, input.limit + 1, offset);
    const results = [];
    let bytes = 0;
    for (const row of rows.slice(0, input.limit)) {
      const hit = {
        reference: {
          documentId: row.documentId,
          versionId: row.versionId,
          representationId: row.representationId,
          unitId: row.unitId,
        },
        sourceId: row.sourceId,
        collection: row.collection,
        path: row.path,
        title: row.title,
        mediaType: row.mediaType,
        snippet: row.text.slice(0, 800),
        snippetTruncated: row.text.length > 800,
        locator: parsedJson<Locator>(row.locator),
        attributes: parsedJson<Attributes>(row.attributes),
        sha256: row.sha256,
        parser: { id: row.parserId, version: row.parserVersion },
        observedAt: row.observedAt,
      };
      const size = Buffer.byteLength(JSON.stringify(hit));
      if (bytes + size > 60000) break;
      results.push(hit);
      bytes += size;
    }
    if (rows.length && !results.length)
      throw new WikiError(
        'wiki_output_limit',
        'Search result metadata exceeds the response budget',
      );
    return {
      ...meta,
      results,
      nextCursor:
        rows.length > results.length
          ? Buffer.from(
              JSON.stringify({
                generation: meta.generation,
                fingerprint,
                offset: offset + results.length,
              }),
            ).toString('base64url')
          : null,
      sourceVerified: false as const,
    };
  }
  read(raw: ReadInput) {
    this.ensureOpen();
    const input = readSchema.parse(raw);
    const ref = input.reference;
    const representation = this.db
      .query<
        {
          title: string;
          mediaType: string;
          attributes: string;
          issues: string;
          sha256: string;
          parserId: string;
          parserVersion: string;
        },
        [string, string, string]
      >(
        `SELECT r.title,r.mediaType,r.attributes,r.issues,v.sha256,r.parserId,r.parserVersion FROM representations r
       JOIN versions v ON v.id=r.versionId JOIN documents d ON d.id=v.documentId
       WHERE r.id=? AND v.id=? AND v.documentId=? AND d.active=1`,
      )
      .get(ref.representationId, ref.versionId, ref.documentId);
    if (!representation)
      throw new WikiError(
        'version_unavailable',
        'Requested version is unavailable or outside active sources',
        404,
      );
    const rows = this.db
      .query<
        { id: string; ordinal: number; text: string; locator: string; data: string | null },
        (string | number | null)[]
      >(
        'SELECT id,ordinal,text,locator,data FROM units WHERE representationId=? AND (? IS NULL OR id=?) ORDER BY ordinal LIMIT ? OFFSET ?',
      )
      .all(
        ref.representationId,
        ref.unitId ?? null,
        ref.unitId ?? null,
        input.limit + 1,
        input.offset,
      );
    if (ref.unitId && !rows.length)
      throw new WikiError('unit_unavailable', 'Requested unit is unavailable', 404);
    const { attributes, issues, ...metadata } = representation;
    const units: { reference: Reference; text: string; locator: Locator; data?: unknown }[] = [];
    const response = {
      reference: ref,
      ...metadata,
      attributes: parsedJson<Attributes>(attributes),
      issues: parsedJson<string[]>(issues),
      units,
      nextOffset: null as number | null,
      sourceVerified: false as const,
      provenance: 'indexed-source-version' as const,
    };
    for (const row of rows.slice(0, input.limit)) {
      const unit = {
        reference: { ...ref, unitId: row.id },
        text: row.text,
        locator: parsedJson<Locator>(row.locator),
        ...(row.data === null ? {} : { data: JSON.parse(row.data) }),
      };
      units.push(unit);
      if (
        Buffer.byteLength(
          JSON.stringify({ ...response, nextOffset: input.offset + units.length }),
        ) > input.maxBytes
      ) {
        units.pop();
        break;
      }
    }
    if (rows.length && !units.length)
      throw new WikiError(
        'wiki_output_limit',
        'A complete unit exceeds maxBytes; increase the read budget',
      );
    response.nextOffset = rows.length > units.length ? input.offset + units.length : null;
    if (Buffer.byteLength(JSON.stringify(response)) > input.maxBytes)
      throw new WikiError('wiki_output_limit', 'Read metadata exceeds maxBytes');
    return response;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    const active = this.active;
    if (active) {
      active.controller.abort();
      await active.done.catch(() => {});
    }
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.owner.close();
    }
  }
}
