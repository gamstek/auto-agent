/** Explicit offline snapshot export. No provider, production configuration or source writes. */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../src/storage';
import { SourceIndex } from '../src/wiki/file-index';
import { INDEX_REVISION, recordSchema } from '../src/wiki/file-index/schema';
import { referenceSections, type ReferenceSettings } from '../src/wiki/file-index/reference';
import { searchBody } from '../src/wiki/file-index/extract';
import { normalizeSearch } from '../src/wiki/search';

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' },
    output: { type: 'string' },
    replace: { type: 'boolean', default: false },
  },
});
if (!args.values.root || !args.values.output)
  throw new Error(
    'Usage: bun scripts/export-library.ts --root <case-directory> --output <library.sqlite> [--replace]',
  );
const root = resolve(args.values.root),
  output = resolve(args.values.output);
const parent = await lstat(dirname(output));
if (!parent.isDirectory() || parent.isSymbolicLink())
  throw new Error('Output parent must be an existing regular directory');
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const current = await lstat(output).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (current && (!args.values.replace || !current.isFile() || current.isSymbolicLink()))
  throw new Error('Existing snapshot requires --replace and must be a regular file');
const oldHash = current ? hash(await readFile(output)) : null;
const temporary = await mkdtemp(join(dirname(output), '.library-export-'));
let store: Store | undefined, snapshot: Database | undefined;
try {
  const config = {
    dataDir: join(temporary, 'working'),
    wikiIndexRoots: [root],
    resourceLimitBytes: 65536,
  };
  store = new Store(config.dataDir);
  const indexed = await new SourceIndex(config, store.db).update(new AbortController().signal);
  const errors = store.db.query("SELECT path, state FROM wiki_files WHERE state='error'").all();
  if (errors.length)
    throw new Error(`Extraction failed for ${errors.length} sources; previous snapshot retained`);
  const rows = store.db
    .query("SELECT data FROM wiki_files WHERE state='parsed' ORDER BY path")
    .all() as { data: string }[];
  if (!rows.length) throw new Error('No supported templates found; previous snapshot retained');
  const skipped = store.db
    .query("SELECT state, count(*) AS count FROM wiki_files WHERE state!='parsed' GROUP BY state")
    .all();
  const file = join(temporary, 'library.sqlite');
  snapshot = new Database(file, { create: true });
  snapshot.exec(`
    CREATE TABLE wiki_files (
      id TEXT PRIMARY KEY, rootId TEXT NOT NULL, path TEXT NOT NULL, directory TEXT NOT NULL, hash TEXT,
      kind TEXT NOT NULL, state TEXT NOT NULL, material TEXT, product TEXT, gas TEXT,
      analysisType TEXT, pressureMode TEXT, clientVersion TEXT, temperatureK REAL,
      data TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE INDEX wiki_source_hash ON wiki_files(hash);
    CREATE INDEX wiki_source_folder ON wiki_files(rootId, directory);
    CREATE INDEX wiki_source_filters ON wiki_files(product, gas, analysisType, temperatureK);
    CREATE VIRTUAL TABLE wiki_file_search USING fts5(id UNINDEXED, body, tokenize='unicode61');
    CREATE TABLE wiki_index_meta (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, indexedAt INTEGER NOT NULL);
    CREATE TABLE wiki_snapshot_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL, exportedAt INTEGER NOT NULL, records INTEGER NOT NULL, note TEXT NOT NULL);
  `);
  const exportedAt = Date.now();
  const rootId = hash('builtin/case-library');
  let pretreatmentFiles = 0,
    pretreatmentEntries = 0,
    reports = 0,
    parameters = 0,
    preservedLabTypes = 0;
  snapshot
    .transaction(() => {
      const insert = snapshot!.prepare(
        'INSERT INTO wiki_files VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      const fts = snapshot!.prepare('INSERT INTO wiki_file_search VALUES (?,?)');
      try {
        for (const row of rows) {
          const record = recordSchema.parse(JSON.parse(row.data));
          record.rootId = rootId;
          record.id = hash(rootId + '\0' + record.path);
          if (!record.configuration || !record.sha256)
            throw new Error('Missing configuration/provenance');
          const sourceFile = record.configuration.file as Record<string, unknown>;
          record.configuration.file = { ...sourceFile, path: record.path };
          record.origin = {
            path: record.path,
            sha256: record.sha256,
            bytes: record.bytes,
            kind: 'sam',
            indexedAt: exportedAt,
            sourceVerified: false,
          };
          const reference = record.configuration.referenceSettings as ReferenceSettings;
          if (reference?.revision !== 'reference-settings-v1')
            throw new Error('Reference extraction missing');
          const entries = Object.values(reference.groups.pretreatment!.fields).filter(
            (field) => typeof field.value === 'string' && field.value.trim().length > 0,
          );
          pretreatmentFiles += Number(entries.length > 0);
          pretreatmentEntries += entries.length;
          reports += reference.reports.length;
          parameters += reference.reports.reduce(
            (sum, report) =>
              sum +
              Object.values(report.parameters).filter((field) => field.presence !== 'missing')
                .length,
            0,
          );
          preservedLabTypes += Number(
            reference.groups.overview!.fields.labType!.presence !== 'missing',
          );
          const body = searchBody(record),
            m = record.metadata;
          insert.run(
            record.id,
            rootId,
            record.path,
            dirname(record.path),
            record.sha256,
            record.kind,
            record.state,
            normalizeSearch(m.materialHint),
            m.product,
            m.gas === null ? null : normalizeSearch(m.gas),
            m.analysisType,
            m.pressureMode,
            m.clientVersion,
            m.temperatureK,
            JSON.stringify(record),
            body,
          );
          fts.run(record.id, body);
        }
        snapshot!
          .query('INSERT INTO wiki_index_meta VALUES (1,?,?)')
          .run(hash(INDEX_REVISION), exportedAt);
        snapshot!
          .query('INSERT INTO wiki_snapshot_meta VALUES (1,?,?,?,?)')
          .run(
            INDEX_REVISION,
            exportedAt,
            rows.length,
            'Historical core experiment and analysis settings; source files unchanged; unsupported formats excluded; no execution verification.',
          );
      } finally {
        insert.finalize();
        fts.finalize();
      }
    })
    .immediate();
  const validation = new SourceIndex(config, snapshot, true);
  const ids = snapshot.query('SELECT id FROM wiki_files ORDER BY id').all() as { id: string }[];
  let fullReadsOverBudget = 0,
    maximumSectionBytes = 0;
  for (const { id } of ids) {
    try {
      await validation.read({ id });
    } catch (error) {
      if ((error as { code?: string }).code !== 'wiki_index_output_limit') throw error;
      fullReadsOverBudget++;
    }
    for (const section of referenceSections) {
      const result = await validation.read({ id, sections: [section] });
      maximumSectionBytes = Math.max(
        maximumSectionBytes,
        Buffer.byteLength(JSON.stringify(result)),
      );
    }
  }
  const integrity = snapshot.query('PRAGMA quick_check').get() as { quick_check: string };
  if (integrity.quick_check !== 'ok') throw new Error('Snapshot integrity check failed');
  snapshot.exec('VACUUM');
  snapshot.close();
  snapshot = undefined;
  store.close();
  store = undefined;
  const publishedBytes = await readFile(file);
  if (publishedBytes.length > 64 * 1024 * 1024)
    throw new Error('Snapshot exceeds bundled 64 MiB limit; previous snapshot retained');
  if (
    current
      ? hash(await readFile(output)) !== oldHash
      : await lstat(output).then(
          () => true,
          (error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        )
  )
    throw new Error('Snapshot destination changed during export; publication aborted');
  await rename(file, output);
  console.log(
    JSON.stringify(
      {
        output,
        revision: INDEX_REVISION,
        scanned: indexed.records,
        records: rows.length,
        skipped,
        pretreatmentFiles,
        pretreatmentEntries,
        preservedLabTypes,
        reports,
        reportParameters: parameters,
        fullReadsOverBudget,
        maximumSectionBytes,
        bytes: publishedBytes.length,
        integrity: 'ok',
        sha256: hash(publishedBytes),
      },
      null,
      2,
    ),
  );
} finally {
  snapshot?.close();
  store?.close();
  await rm(temporary, { recursive: true, force: true });
}
