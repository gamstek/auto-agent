import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Experiment = { tubeCode: string; experimentId: string };

/** Only write receipts for the external instrument API; the instrument owns experiment state. */
export function pendingCreates(dataDir: string, serviceURL: string) {
  const directory = join(dataDir, 'automation');
  const file = join(directory, 'pending-creates.sqlite');
  const service = new URL(serviceURL).href.replace(/\/$/, '');

  function transaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(file);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS pending_create (
          service TEXT NOT NULL, tube_code TEXT NOT NULL, experiment_id TEXT NOT NULL,
          PRIMARY KEY (service, tube_code), UNIQUE (service, experiment_id)
        );
        BEGIN IMMEDIATE;`);
      const result = operation(db);
      db.exec('COMMIT');
      return result;
    } finally {
      // Closing also rolls back an unfinished transaction.
      db.close();
    }
  }

  return {
    reserve(items: Experiment[]): Map<string, string> {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return transaction((db) => {
        const insert = db.prepare(`INSERT INTO pending_create VALUES (?, ?, ?)
          ON CONFLICT (service, tube_code) DO NOTHING`);
        const get = db.prepare(
          'SELECT experiment_id FROM pending_create WHERE service=? AND tube_code=?',
        );
        const blocked = new Map<string, string>();
        for (const { tubeCode, experimentId } of items) {
          if (!insert.run(service, tubeCode, experimentId).changes) {
            const previous = get.get(service, tubeCode) as { experiment_id: string };
            blocked.set(tubeCode, previous.experiment_id);
          }
        }
        return blocked;
      });
    },
    resolve(experimentIds: string[]) {
      if (!experimentIds.length || !existsSync(file)) return;
      transaction((db) => {
        const remove = db.prepare('DELETE FROM pending_create WHERE service=? AND experiment_id=?');
        for (const id of experimentIds) remove.run(service, id);
      });
    },
  };
}
