import { Database } from 'bun:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, type Message, type ScriptResult, type Session } from '../shared/types';
import { migrate } from './migrations';

type RunStatus = 'completed' | 'failed' | 'cancelled' | 'waiting_for_operator';

export function validatePage(limit: number, offset: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new AppError(
      'invalid_pagination',
      'limit must be 1–1000 and offset a nonnegative safe integer',
    );
}

export class Store {
  readonly db: Database;
  private readonly ownership: Database;
  private closed = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const directory = realpathSync(dataDir);
    // A separate rollback-journal database keeps the OS lock for this owner's
    // lifetime. Kernel release on process death avoids PID reuse and stale-file races.
    this.ownership = new Database(join(directory, 'ownership.sqlite'), { create: true });
    try {
      this.ownership.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
      this.ownership.exec('CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY)');
    } catch {
      this.ownership.close();
      throw new AppError(
        'DATA_DIR_LOCKED',
        'Data directory is already owned by another service or CLI.',
        409,
      );
    }
    let db: Database | undefined;
    try {
      db = new Database(join(directory, 'storage.sqlite'), { create: true });
      this.db = db;
      db.exec(
        'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000',
      );
      migrate(
        db,
        'store-1',
        `
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), content TEXT NOT NULL, createdAt INTEGER NOT NULL
        );
        CREATE INDEX messages_session ON messages(sessionId, createdAt);
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
          messageId TEXT NOT NULL REFERENCES messages(id),
          status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'waiting_for_operator')),
          createdAt INTEGER NOT NULL, finishedAt INTEGER
        );
        CREATE UNIQUE INDEX one_active_run ON runs(sessionId) WHERE status IN ('running', 'waiting_for_operator');
        CREATE TABLE executions (
          id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id), skill TEXT NOT NULL, path TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('executing', 'completed', 'failed', 'cancelled', 'timeout', 'output_limit', 'unknown')),
          exitCode INTEGER, createdAt INTEGER NOT NULL, finishedAt INTEGER
        );
      `,
      );
      migrate(
        db,
        'store-2-session-ownership',
        `
        DROP INDEX IF EXISTS one_active_run;
        CREATE UNIQUE INDEX one_active_run ON runs(sessionId) WHERE status IN ('running', 'waiting_for_operator');
      `,
      );
      migrate(
        db,
        'store-3-auto-title',
        `
        ALTER TABLE sessions ADD COLUMN autoTitle INTEGER NOT NULL DEFAULT 0;
        UPDATE sessions SET autoTitle = 1 WHERE title = 'New session';
      `,
      );
      migrate(
        db,
        'store-4-session-list-index',
        'CREATE INDEX sessions_updated ON sessions(updatedAt);',
      );
      migrate(
        db,
        'store-5-message-reasoning',
        `CREATE TABLE message_reasoning (
          messageId TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          content TEXT NOT NULL
        );`,
      );
      this.recover();
    } catch (error) {
      db?.close();
      this.ownership.close();
      throw error;
    }
  }

  private recover(): void {
    this.db
      .transaction(() => {
        const interrupted = this.db
          .query<{ id: string; sessionId: string }, []>(
            "SELECT id, sessionId FROM runs WHERE status = 'running'",
          )
          .all();
        const affected = new Set(
          this.db
            .query<{ runId: string }, []>(
              "SELECT DISTINCT runId FROM executions WHERE status = 'executing'",
            )
            .all()
            .map((row) => row.runId),
        );
        this.db
          .query(
            "UPDATE executions SET status = 'unknown', finishedAt = ? WHERE status = 'executing'",
          )
          .run(Date.now());
        for (const run of interrupted) {
          const unknown = affected.has(run.id);
          this.db
            .query('UPDATE runs SET status = ?, finishedAt = ? WHERE id = ?')
            .run(unknown ? 'waiting_for_operator' : 'failed', unknown ? null : Date.now(), run.id);
          this.addMessage(
            run.sessionId,
            'assistant',
            unknown
              ? 'An interrupted script has an unknown outcome. This run is waiting for operator review; scripts will not be automatically replayed. Verify external effects before starting another run.'
              : 'This run was interrupted and has been marked failed. It will not be automatically resumed.',
          );
        }
      })
      .immediate();
  }

  createSession(title?: string): Session {
    const now = Date.now();
    const session = {
      id: randomUUID(),
      title: title ?? 'New session',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .query(
        'INSERT INTO sessions (id, title, createdAt, updatedAt, autoTitle) VALUES (?, ?, ?, ?, ?)',
      )
      .run(session.id, session.title, now, now, title === undefined ? 1 : 0);
    return session;
  }

  needsTitle(id: string): boolean {
    this.getSession(id);
    return (
      this.db
        .query<{ autoTitle: number }, [string]>('SELECT autoTitle FROM sessions WHERE id = ?')
        .get(id)?.autoTitle === 1
    );
  }

  setGeneratedTitle(id: string, title: string): boolean {
    return (
      this.db
        .query(
          'UPDATE sessions SET title = ?, autoTitle = 0, updatedAt = ? WHERE id = ? AND autoTitle = 1',
        )
        .run(title, Date.now(), id).changes > 0
    );
  }

  listSessions(limit = 100, offset = 0): Session[] {
    validatePage(limit, offset);
    return this.db
      .query<Session, [number, number]>(
        'SELECT id, title, createdAt, updatedAt FROM sessions ORDER BY updatedAt DESC, rowid DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset);
  }

  getSession(id: string): Session {
    const session = this.db
      .query<Session, [string]>('SELECT id, title, createdAt, updatedAt FROM sessions WHERE id = ?')
      .get(id);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found.', 404);
    return session;
  }

  messages(id: string, limit = 100, offset = 0): Message[] {
    this.getSession(id);
    validatePage(limit, offset);
    return this.db
      .query<Message, [string, number, number]>(
        'SELECT * FROM messages WHERE sessionId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?',
      )
      .all(id, limit, offset)
      .reverse();
  }

  contextMessages(id: string, maxBytes: number): (Message & { reasoning?: string })[] {
    this.getSession(id);
    const history: (Message & { reasoning?: string })[] = [];
    let bytes = 0;
    const statement = this.db.prepare<Message & { reasoning: string | null }, [string]>(
      `SELECT m.*, r.content AS reasoning FROM messages m
       LEFT JOIN message_reasoning r ON r.messageId = m.id
       WHERE m.sessionId = ? ORDER BY m.createdAt DESC, m.rowid DESC`,
    );
    try {
      for (const message of statement.iterate(id)) {
        bytes += Buffer.byteLength(message.content) + Buffer.byteLength(message.reasoning ?? '');
        if (bytes > maxBytes) break;
        const { reasoning, ...publicMessage } = message;
        history.push(reasoning ? { ...publicMessage, reasoning } : publicMessage);
      }
    } finally {
      statement.finalize();
    }
    return history.reverse();
  }

  firstUserContent(id: string): string {
    return (
      this.db
        .query<{ content: string }, [string]>(
          "SELECT substr(content, 1, 2000) AS content FROM messages WHERE sessionId = ? AND role = 'user' ORDER BY createdAt, rowid LIMIT 1",
        )
        .get(id)?.content ?? ''
    );
  }

  addMessage(
    sessionId: string,
    role: Message['role'],
    content: string,
    id: string = randomUUID(),
    reasoning?: string,
  ): Message {
    return this.db
      .transaction(() => {
        this.getSession(sessionId);
        const createdAt = Date.now();
        this.db
          .query('INSERT INTO messages VALUES (?, ?, ?, ?, ?)')
          .run(id, sessionId, role, content, createdAt);
        if (role === 'assistant' && reasoning)
          this.db.query('INSERT INTO message_reasoning VALUES (?, ?)').run(id, reasoning);
        this.db.query('UPDATE sessions SET updatedAt = ? WHERE id = ?').run(createdAt, sessionId);
        return { id, sessionId, role, content, createdAt };
      })
      .immediate();
  }

  beginRun(sessionId: string, messageId: string): string {
    return this.db
      .transaction(() => {
        this.getSession(sessionId);
        if (
          !this.db
            .query('SELECT id FROM messages WHERE id = ? AND sessionId = ?')
            .get(messageId, sessionId)
        ) {
          throw new AppError('MESSAGE_NOT_FOUND', 'Message not found in this session.', 404);
        }
        if (
          this.db
            .query(
              "SELECT id FROM runs WHERE sessionId = ? AND status IN ('running', 'waiting_for_operator')",
            )
            .get(sessionId)
        ) {
          throw new AppError(
            'RUN_CONFLICT',
            'An active run or operator review already owns execution.',
            409,
          );
        }
        const id = randomUUID();
        this.db
          .query("INSERT INTO runs VALUES (?, ?, ?, 'running', ?, NULL)")
          .run(id, sessionId, messageId, Date.now());
        return id;
      })
      .immediate();
  }

  finishRun(runId: string, status: RunStatus): void {
    this.db
      .transaction(() => {
        const run = this.db
          .query<{ status: string }, [string]>('SELECT status FROM runs WHERE id = ?')
          .get(runId);
        if (!run) throw new AppError('RUN_NOT_FOUND', 'Run not found.', 404);
        if (run.status === status) return;
        if (run.status !== 'running' && run.status !== 'waiting_for_operator') {
          throw new AppError('RUN_FINISHED', 'Run is already finished.', 409);
        }
        if (
          this.db
            .query("SELECT id FROM executions WHERE runId = ? AND status = 'executing'")
            .get(runId)
        ) {
          throw new AppError(
            'EXECUTION_ACTIVE',
            'Finish the active execution before finishing its run.',
            409,
          );
        }
        if (
          status !== 'waiting_for_operator' &&
          !['completed', 'failed', 'cancelled'].includes(status)
        ) {
          throw new AppError('INVALID_RUN_STATUS', 'Invalid run status.');
        }
        this.db
          .query('UPDATE runs SET status = ?, finishedAt = ? WHERE id = ?')
          .run(status, status === 'waiting_for_operator' ? null : Date.now(), runId);
      })
      .immediate();
  }

  beginExecution(runId: string, skill: string, path: string): string {
    return this.db
      .transaction(() => {
        const run = this.db
          .query<{ status: string }, [string]>('SELECT status FROM runs WHERE id = ?')
          .get(runId);
        if (!run) throw new AppError('RUN_NOT_FOUND', 'Run not found.', 404);
        if (run.status !== 'running')
          throw new AppError('RUN_NOT_RUNNING', 'Run is not running.', 409);
        const id = randomUUID();
        this.db
          .query("INSERT INTO executions VALUES (?, ?, ?, ?, 'executing', NULL, ?, NULL)")
          .run(id, runId, skill, path, Date.now());
        return id;
      })
      .immediate();
  }

  finishExecution(id: string, result: ScriptResult): void {
    this.db
      .transaction(() => {
        const execution = this.db
          .query<{ status: string }, [string]>('SELECT status FROM executions WHERE id = ?')
          .get(id);
        if (!execution) throw new AppError('EXECUTION_NOT_FOUND', 'Execution not found.', 404);
        if (execution.status !== 'executing')
          throw new AppError(
            'EXECUTION_FINISHED',
            'Execution is already finished; unknown outcomes require operator review.',
            409,
          );
        // Persist the outcome only, never stdout, stderr or invocation arguments.
        this.db
          .query('UPDATE executions SET status = ?, exitCode = ?, finishedAt = ? WHERE id = ?')
          .run(result.status, result.exitCode, Date.now(), id);
      })
      .immediate();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.ownership.close();
    }
  }
}
