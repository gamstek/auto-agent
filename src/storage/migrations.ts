import type { Database } from 'bun:sqlite';

export function migrate(db: Database, id: string, sql: string): void {
  db.transaction(() => {
    db.exec(
      'CREATE TABLE IF NOT EXISTS storage_migrations (id TEXT PRIMARY KEY, appliedAt INTEGER NOT NULL)',
    );
    if (db.query('SELECT id FROM storage_migrations WHERE id = ?').get(id)) return;
    db.exec(sql);
    db.query('INSERT INTO storage_migrations VALUES (?, ?)').run(id, Date.now());
  }).immediate();
}
