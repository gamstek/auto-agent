import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/** Small synchronous store adapter shared by the Wiki index and bundle publisher. */
export class Database {
  private readonly database: DatabaseSync;

  constructor(path: string, options: { readonly?: boolean; create?: boolean } = {}) {
    this.database = new DatabaseSync(path, { readOnly: options.readonly ?? false });
  }

  exec(sql: string) {
    this.database.exec(sql);
  }

  query<Row = Record<string, unknown>, Params extends SQLInputValue[] = SQLInputValue[]>(
    sql: string,
  ) {
    const statement = this.database.prepare(sql);
    return {
      all: (...params: Params): Row[] => statement.all(...params) as Row[],
      get: (...params: Params): Row | null => (statement.get(...params) as Row | undefined) ?? null,
      run: (...params: Params) => statement.run(...params),
      iterate: (...params: Params) => statement.iterate(...params) as IterableIterator<Row>,
      // node:sqlite owns the prepared statement lifetime.
      finalize() {},
    };
  }

  prepare<Row = Record<string, unknown>, Params extends SQLInputValue[] = SQLInputValue[]>(
    sql: string,
  ) {
    return this.query<Row, Params>(sql);
  }

  transaction<T>(work: () => T) {
    const run = (mode: string): T => {
      this.exec(`BEGIN ${mode}`);
      try {
        const result = work();
        this.exec('COMMIT');
        return result;
      } catch (error) {
        this.exec('ROLLBACK');
        throw error;
      }
    };
    return Object.assign(() => run('DEFERRED'), { immediate: () => run('IMMEDIATE') });
  }

  close() {
    this.database.close();
  }
}
