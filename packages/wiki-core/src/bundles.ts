import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WikiError } from './contracts';
import { hash } from './files';

export interface PublishedBundle { id: string; path: string }
const schemaVersion = 3;

/** Materialize a published index, without parsing sources or invoking models. */
export function materializeBundles(db: Database, bundles: readonly PublishedBundle[]): void {
  if (new Set(bundles.map((bundle) => bundle.id)).size !== bundles.length)
    throw new WikiError('wiki_bundle', 'Bundle IDs must be unique');
  const configured = new Set(bundles.map((bundle) => bundle.id));
  let changed = false;
  db.transaction(() => {
    for (const row of db.query<{ id: string }, []>('SELECT id FROM bundles').all()) {
      if (configured.has(row.id)) continue;
      db.query('UPDATE documents SET active=0 WHERE sourceId IN (SELECT id FROM sources WHERE bundleId=?)').run(row.id);
      db.query('UPDATE sources SET active=0 WHERE bundleId=?').run(row.id);
      db.query('DELETE FROM bundles WHERE id=?').run(row.id);
      changed = true;
    }
  }).immediate();

  for (const bundle of bundles) {
    const path = resolve(bundle.path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024)
      throw new WikiError('wiki_bundle', 'Published bundle must be a bounded regular SQLite file');
    const digest = hash(readFileSync(path));
    const saved = db.query<{ digest: string }, [string]>('SELECT digest FROM bundles WHERE id=?').get(bundle.id);
    if (saved?.digest === digest) continue;
    const snapshot = new Database(path, { readonly: true });
    let sources: { id: string; collection: string }[];
    try {
      if (snapshot.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version !== schemaVersion)
        throw new WikiError('wiki_bundle', 'Bundle schema does not match the current Wiki protocol');
      if (snapshot.query<{ quick_check: string }, []>('PRAGMA quick_check').get()!.quick_check !== 'ok')
        throw new WikiError('wiki_bundle', 'Bundle integrity check failed');
      sources = snapshot.query<{ id: string; collection: string }, []>('SELECT id,collection FROM sources WHERE active=1 ORDER BY id').all();
      if (sources.length > 100) throw new WikiError('wiki_bundle', 'Bundle source count exceeds its limit');
      for (const source of sources) {
        const existing = db.query<{ bundleId: string | null }, [string]>('SELECT bundleId FROM sources WHERE id=?').get(source.id);
        if (existing && existing.bundleId !== bundle.id) throw new WikiError('wiki_bundle_conflict', 'Bundle source ID conflicts with another source');
      }
      const copy = (table: string, mode: 'IGNORE' | 'REPLACE' = 'IGNORE') => {
        const rows = snapshot.query<Record<string, string | number | null>, []>(`SELECT * FROM ${table}`);
        let insert: ReturnType<Database['prepare']> | undefined;
        try {
          for (const row of rows.iterate()) {
            insert ??= db.prepare(`INSERT OR ${mode} INTO ${table} VALUES (${Object.keys(row).map(() => '?').join(',')})`);
            insert.run(...Object.values(row));
          }
        } finally { rows.finalize(); insert?.finalize(); }
      };
      db.transaction(() => {
        db.query(`DELETE FROM wiki_fts WHERE unitId IN (
          SELECT u.id FROM units u JOIN representations r ON r.id=u.representationId
          JOIN versions v ON v.id=r.versionId JOIN documents d ON d.id=v.documentId
          JOIN sources s ON s.id=d.sourceId WHERE s.bundleId=?)`).run(bundle.id);
        db.query('UPDATE documents SET active=0 WHERE sourceId IN (SELECT id FROM sources WHERE bundleId=?)').run(bundle.id);
        db.query('UPDATE sources SET active=0 WHERE bundleId=?').run(bundle.id);
        for (const source of sources) db.query(`INSERT INTO sources VALUES (?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET
          collection=excluded.collection,config=excluded.config,active=1,bundleId=excluded.bundleId`).run(
          source.id, source.collection, JSON.stringify({ id: source.id, type: 'bundle', bundleId: bundle.id }), bundle.id,
        );
        for (const table of ['versions', 'representations', 'units', 'wiki_fts']) copy(table);
        copy('documents', 'REPLACE');
        db.query('INSERT OR REPLACE INTO bundles VALUES (?,?)').run(bundle.id, digest);
      }).immediate();
      changed = true;
    } finally { snapshot.close(); }
  }
  if (changed) db.query('INSERT INTO wiki_meta VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,publishedAt=excluded.publishedAt').run(crypto.randomUUID(), Date.now());
}

/** Publish only current reference content; paths, build history and inactive versions stay local. */
export function exportBundle(db: Database, output: string): void {
  const path = resolve(output);
  if (existsSync(path)) throw new WikiError('wiki_bundle_exists', 'Bundle destination already exists');
  db.query('VACUUM INTO ?').run(path);
  const snapshot = new Database(path);
  try {
    snapshot.exec(`PRAGMA journal_mode=DELETE;
      DELETE FROM documents WHERE active=0;
      DELETE FROM wiki_fts WHERE unitId IN (SELECT id FROM units WHERE representationId NOT IN (SELECT representationId FROM documents));
      DELETE FROM units WHERE representationId NOT IN (SELECT representationId FROM documents);
      DELETE FROM representations WHERE id NOT IN (SELECT representationId FROM documents);
      DELETE FROM versions WHERE id NOT IN (SELECT versionId FROM documents);
      DELETE FROM sources WHERE id NOT IN (SELECT sourceId FROM documents);
      UPDATE sources SET config=json_object('id',id,'type','bundle'),bundleId=NULL;
      DELETE FROM builds; DELETE FROM bundles; VACUUM;
    `);
  } finally { snapshot.close(); }
}
