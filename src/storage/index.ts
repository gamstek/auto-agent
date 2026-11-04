import { Database } from 'bun:sqlite';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, type Message, type ScriptResult, type Session } from '../shared/types';
import { migrate } from './migrations';
import { RunTraceStore } from './traces';
import { RunTranscriptStore } from './transcripts';

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
  readonly traces: RunTraceStore;
  readonly transcripts: RunTranscriptStore;
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
      migrate(
        db,
        'store-6-wiki-file-index',
        `
        CREATE TABLE wiki_index_meta (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, indexedAt INTEGER NOT NULL);
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
      `,
      );
      migrate(
        db,
        'store-7-execution-diagnostics',
        `
        CREATE TABLE execution_diagnostics (
          executionId TEXT PRIMARY KEY REFERENCES executions(id), data TEXT NOT NULL
        );
        CREATE TABLE run_reviews (
          runId TEXT PRIMARY KEY REFERENCES runs(id), note TEXT NOT NULL, resolvedAt INTEGER NOT NULL
        );
      `,
      );
      migrate(
        db,
        'store-8-session-context',
        `CREATE TABLE session_context (
        sessionId TEXT PRIMARY KEY REFERENCES sessions(id), throughRow INTEGER NOT NULL,
        summary TEXT NOT NULL, updatedAt INTEGER NOT NULL
      );`,
      );
      migrate(
        db,
        'store-9-mcp-operations',
        `
        CREATE TABLE tool_operations (
          id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES runs(id), serverId TEXT NOT NULL, toolName TEXT NOT NULL,
          inputHash TEXT NOT NULL, resourceKey TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('dispatching','confirmed','rejected','unknown')),
          createdAt INTEGER NOT NULL, finishedAt INTEGER,
          UNIQUE(runId, resourceKey, toolName, inputHash)
        );
        CREATE INDEX tool_operations_server ON tool_operations(serverId,status);
      `,
      );
      migrate(
        db,
        'store-10-tool-evidence',
        `
        CREATE TABLE tool_evidence (runId TEXT NOT NULL REFERENCES runs(id), toolCallId TEXT NOT NULL,
          toolName TEXT NOT NULL, status TEXT NOT NULL, effect TEXT NOT NULL, metadata TEXT NOT NULL,
          PRIMARY KEY(runId,toolCallId));
        CREATE TABLE run_messages (runId TEXT PRIMARY KEY REFERENCES runs(id), messageId TEXT NOT NULL REFERENCES messages(id));
      `,
      );
      this.traces = new RunTraceStore(db);
      this.transcripts = new RunTranscriptStore(db);
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
        for (const row of this.db
          .query<{ runId: string }, []>(
            "SELECT DISTINCT runId FROM tool_operations WHERE status IN ('dispatching','unknown')",
          )
          .all())
          affected.add(row.runId);
        this.db
          .query(
            "UPDATE tool_operations SET status='unknown',finishedAt=? WHERE status='dispatching'",
          )
          .run(Date.now());
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
          const reply = this.addMessage(
            run.sessionId,
            'assistant',
            unknown
              ? 'An interrupted operation has an unknown outcome. This run is waiting for operator review; operations will not be automatically replayed. Verify external effects before starting another run.'
              : 'This run was interrupted and has been marked failed. It will not be automatically resumed.',
          );
          this.db.query('INSERT INTO run_messages VALUES (?,?)').run(run.id, reply.id);
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

  messages(
    id: string,
    limit = 100,
    offset = 0,
    includeReasoning = false,
    includeProcess = false,
  ): Message[] {
    this.getSession(id);
    validatePage(limit, offset);
    return this.db
      .query<
        Message & { reasoning: string | null; runId: string | null },
        [string, number, number]
      >(
        'SELECT m.*,r.content AS reasoning,rm.runId FROM messages m LEFT JOIN message_reasoning r ON r.messageId=m.id LEFT JOIN run_messages rm ON rm.messageId=m.id WHERE m.sessionId = ? ORDER BY m.createdAt DESC, m.rowid DESC LIMIT ? OFFSET ?',
      )
      .all(id, limit, offset)
      .map(({ reasoning, runId, ...message }) => ({
        ...message,
        ...(includeReasoning && reasoning ? { reasoning } : {}),
        ...(includeProcess && runId ? { runId } : {}),
      }))
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
        if (bytes > maxBytes)
          throw new AppError(
            'context_history_limit',
            'History exceeds the requested byte budget; load a context window and summarize the omitted prefix.',
          );
        const { reasoning, ...publicMessage } = message;
        history.push(reasoning ? { ...publicMessage, reasoning } : publicMessage);
      }
    } finally {
      statement.finalize();
    }
    return history.reverse();
  }

  contextSummary(sessionId: string) {
    this.getSession(sessionId);
    return (
      this.db
        .query<{ throughRow: number; summary: string }, [string]>(
          'SELECT throughRow,summary FROM session_context WHERE sessionId=?',
        )
        .get(sessionId) ?? { throughRow: 0, summary: '' }
    );
  }

  /** Read either the recent tail or the next prefix batch; never hide omitted rows. */
  contextWindow(sessionId: string, afterRow: number, maxBytes: number, beforeRow?: number) {
    this.getSession(sessionId);
    type Row = Message & { reasoning: string | null; row: number; evidence?: unknown[] };
    const statement = this.db.prepare<Row, (string | number)[]>(
      `SELECT m.*,m.rowid AS row,r.content AS reasoning FROM messages m
       LEFT JOIN message_reasoning r ON r.messageId=m.id
       WHERE m.sessionId=? AND m.rowid>? ${beforeRow === undefined ? '' : 'AND m.rowid<?'}
       ORDER BY m.rowid ${beforeRow === undefined ? 'DESC' : 'ASC'}`,
    );
    const messages: Row[] = [];
    let bytes = 0,
      truncated = false;
    try {
      for (const message of statement.iterate(
        sessionId,
        afterRow,
        ...(beforeRow === undefined ? [] : [beforeRow]),
      )) {
        const evidence = this.db
          .query<
            {
              toolCallId: string;
              toolName: string;
              status: string;
              effect: string;
              metadata: string;
            },
            [string]
          >(
            `SELECT e.toolCallId,e.toolName,e.status,e.effect,e.metadata FROM tool_evidence e
           JOIN run_messages rm ON rm.runId=e.runId WHERE rm.messageId=? ORDER BY e.rowid`,
          )
          .all(message.id);
        if (evidence.length)
          message.evidence = evidence.map(({ metadata, ...entry }) => ({
            ...entry,
            metadata: JSON.parse(metadata),
          }));
        const size = Buffer.byteLength(JSON.stringify(message));
        if (bytes + size > maxBytes) {
          if (!messages.length)
            throw new AppError(
              'context_history_limit',
              'A historical message exceeds the context loading budget; increase maxInputTokens. No history was discarded.',
            );
          truncated = true;
          break;
        }
        bytes += size;
        messages.push(message);
      }
    } finally {
      statement.finalize();
    }
    if (beforeRow === undefined) messages.reverse();
    return { messages, truncated, bytes };
  }

  saveContextSummary(
    sessionId: string,
    expectedRow: number,
    throughRow: number,
    summary: string,
  ): void {
    if (!summary.trim() || Buffer.byteLength(summary) > 1024 * 1024)
      throw new AppError('context_summary', 'Historical summary is empty or exceeds 1 MiB');
    this.db
      .transaction(() => {
        if (
          this.contextSummary(sessionId).throughRow !== expectedRow ||
          throughRow <= expectedRow ||
          !this.db
            .query('SELECT id FROM messages WHERE sessionId=? AND rowid=?')
            .get(sessionId, throughRow)
        )
          throw new AppError(
            'context_summary_conflict',
            'History changed during summarization',
            409,
          );
        this.db
          .query(
            'INSERT INTO session_context VALUES (?,?,?,?) ON CONFLICT(sessionId) DO UPDATE SET throughRow=excluded.throughRow,summary=excluded.summary,updatedAt=excluded.updatedAt',
          )
          .run(sessionId, throughRow, summary, Date.now());
      })
      .immediate();
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

  beginTurn(sessionId: string, content: string): string {
    return this.db
      .transaction(() => this.beginRun(sessionId, this.addMessage(sessionId, 'user', content).id))
      .immediate();
  }

  recordReviewReply(sessionId: string, content: string, report: string): Message {
    return this.db
      .transaction(() => {
        this.addMessage(sessionId, 'user', content);
        return this.addMessage(sessionId, 'assistant', report);
      })
      .immediate();
  }

  latestRun(sessionId: string) {
    return this.db
      .query<
        { id: string; status: string; createdAt: number; finishedAt: number | null },
        [string]
      >(
        'SELECT id,status,createdAt,finishedAt FROM runs WHERE sessionId=? ORDER BY createdAt DESC,rowid DESC LIMIT 1',
      )
      .get(sessionId);
  }

  recordToolEvidence(
    runId: string,
    evidence: {
      toolCallId: string;
      toolName: string;
      status: string;
      effect: string;
      metadata: unknown;
    },
  ) {
    const metadata = JSON.stringify(evidence.metadata);
    if (
      Buffer.byteLength(metadata) > 4096 ||
      evidence.toolCallId.length > 256 ||
      evidence.toolName.length > 256
    )
      throw new AppError('tool_evidence_limit', 'Tool evidence exceeds its storage limit');
    this.db
      .query('INSERT INTO tool_evidence VALUES (?,?,?,?,?,?)')
      .run(
        runId,
        evidence.toolCallId,
        evidence.toolName,
        evidence.status,
        evidence.effect,
        metadata,
      );
  }

  completeRun(
    runId: string,
    sessionId: string,
    messageId: string,
    output: { text: string; reasoning?: string },
  ): Message {
    return this.finalizeTurn(
      runId,
      sessionId,
      messageId,
      'completed',
      output.text,
      output.reasoning,
    );
  }

  failRun(
    runId: string,
    sessionId: string,
    messageId: string,
    status: 'failed' | 'cancelled' | 'waiting_for_operator',
    content: string,
    reasoning?: string,
  ): Message {
    return this.finalizeTurn(runId, sessionId, messageId, status, content, reasoning);
  }

  private finalizeTurn(
    runId: string,
    sessionId: string,
    messageId: string,
    status: RunStatus,
    content: string,
    reasoning?: string,
  ): Message {
    return this.db
      .transaction(() => {
        if (this.runSessionId(runId) !== sessionId)
          throw new AppError('RUN_CONFLICT', 'Run belongs to another session', 409);
        if (status === 'waiting_for_operator') {
          this.db
            .query(
              "UPDATE executions SET status='unknown',finishedAt=? WHERE runId=? AND status='executing'",
            )
            .run(Date.now(), runId);
          this.db
            .query(
              "UPDATE tool_operations SET status='unknown',finishedAt=? WHERE runId=? AND status='dispatching'",
            )
            .run(Date.now(), runId);
        }
        const reply = this.addMessage(sessionId, 'assistant', content, messageId, reasoning);
        this.finishRun(runId, status);
        this.db.query('INSERT INTO run_messages VALUES (?,?)').run(runId, messageId);
        return reply;
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
            .get(runId) ||
          this.db
            .query("SELECT id FROM tool_operations WHERE runId=? AND status='dispatching'")
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

  finishExecution(id: string, result: ScriptResult, diagnostic?: Record<string, unknown>): void {
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
        if (diagnostic) {
          let data = JSON.stringify(diagnostic);
          if (Buffer.byteLength(data) > 16384)
            data = JSON.stringify({
              truncated: true,
              ...Object.fromEntries(
                ['code', 'message', 'batchId', 'stage', 'status']
                  .filter((key) => ['string', 'number', 'boolean'].includes(typeof diagnostic[key]))
                  .map((key) => [
                    key,
                    typeof diagnostic[key] === 'string'
                      ? diagnostic[key].slice(0, 2000)
                      : diagnostic[key],
                  ]),
              ),
            });
          this.db.query('INSERT INTO execution_diagnostics VALUES (?, ?)').run(id, data);
        }
      })
      .immediate();
  }

  pendingReview(sessionId: string) {
    this.getSession(sessionId);
    const run = this.db
      .query<{ id: string; createdAt: number }, [string]>(
        "SELECT id, createdAt FROM runs WHERE sessionId=? AND status='waiting_for_operator' ORDER BY createdAt DESC LIMIT 1",
      )
      .get(sessionId);
    if (!run) return null;
    const executions = this.db
      .query<
        {
          id: string;
          skill: string;
          path: string;
          status: string;
          exitCode: number | null;
          createdAt: number;
          finishedAt: number | null;
          data: string | null;
        },
        [string]
      >(
        'SELECT e.*, d.data FROM executions e LEFT JOIN execution_diagnostics d ON d.executionId=e.id WHERE e.runId=? ORDER BY e.createdAt DESC LIMIT 16',
      )
      .all(run.id)
      .map(({ data, ...execution }) => ({
        ...execution,
        diagnostic: data ? (JSON.parse(data) as Record<string, unknown>) : null,
      }));
    const operations = this.db
      .query<
        {
          id: string;
          serverId: string;
          toolName: string;
          status: string;
          createdAt: number;
          finishedAt: number | null;
        },
        [string]
      >('SELECT * FROM tool_operations WHERE runId=? ORDER BY createdAt DESC LIMIT 16')
      .all(run.id)
      .map((operation) => ({
        id: operation.id,
        serverId: operation.serverId,
        toolName: operation.toolName,
        status: operation.status,
        createdAt: operation.createdAt,
        finishedAt: operation.finishedAt,
        diagnostic: {
          stage: operation.toolName,
          code: operation.status === 'unknown' ? 'OUTCOME_UNKNOWN' : operation.status,
        } as Record<string, unknown>,
      }));
    return { ...run, executions, operations };
  }

  beginToolOperation(
    runId: string,
    serverId: string,
    toolName: string,
    inputHash: string,
    resourceKey = serverId,
  ): string {
    return this.db
      .transaction(() => {
        const run = this.db
          .query<{ sessionId: string; status: string }, [string]>(
            'SELECT sessionId,status FROM runs WHERE id=?',
          )
          .get(runId);
        if (run?.status !== 'running')
          throw new AppError('RUN_NOT_RUNNING', 'Run is not running', 409);
        if (
          this.db
            .query(
              'SELECT id FROM tool_operations WHERE runId=? AND resourceKey=? AND toolName=? AND inputHash=?',
            )
            .get(runId, resourceKey, toolName, inputHash)
        )
          throw new AppError(
            'replay_blocked',
            'This operation was already attempted in this generation',
            409,
          );
        if (
          this.db
            .query(
              "SELECT o.id FROM tool_operations o WHERE (serverId=? OR resourceKey=?) AND status='unknown' AND NOT EXISTS (SELECT 1 FROM run_reviews r WHERE r.runId=o.runId)",
            )
            .get(serverId, resourceKey)
        )
          throw new AppError(
            'mcp_review_required',
            'This MCP server has an unresolved write; record operator reconciliation first',
            409,
          );
        const id = randomUUID();
        this.db
          .query(
            "INSERT INTO tool_operations(id,runId,serverId,toolName,inputHash,resourceKey,status,createdAt,finishedAt) VALUES (?,?,?,?,?,?,'dispatching',?,NULL)",
          )
          .run(id, runId, serverId, toolName, inputHash, resourceKey, Date.now());
        return id;
      })
      .immediate();
  }
  finishToolOperation(id: string, status: 'confirmed' | 'rejected' | 'unknown') {
    this.db
      .transaction(() => {
        const operation = this.db
          .query<{ status: string }, [string]>('SELECT * FROM tool_operations WHERE id=?')
          .get(id);
        if (operation?.status !== 'dispatching')
          throw new AppError('EXECUTION_FINISHED', 'Operation cannot be overwritten', 409);
        this.db
          .query('UPDATE tool_operations SET status=?,finishedAt=? WHERE id=?')
          .run(status, Date.now(), id);
      })
      .immediate();
  }
  runSessionId(runId: string): string {
    const row = this.db
      .query<{ sessionId: string }, [string]>('SELECT sessionId FROM runs WHERE id=?')
      .get(runId);
    if (!row) throw new AppError('RUN_NOT_FOUND', 'Run not found', 404);
    return row.sessionId;
  }

  resolveReview(sessionId: string, runId: string, note: string): void {
    if (typeof note !== 'string' || !note.trim() || Buffer.byteLength(note) > 2000)
      throw new AppError(
        'invalid_review',
        'An operator reconciliation note is required (up to 2000 bytes).',
      );
    this.db
      .transaction(() => {
        const pending = this.pendingReview(sessionId);
        if (!pending || pending.id !== runId)
          throw new AppError(
            'review_conflict',
            'The run is not awaiting review in this session.',
            409,
          );
        this.finishRun(runId, 'failed');
        this.db
          .query('INSERT INTO run_reviews VALUES (?, ?, ?)')
          .run(runId, note.trim(), Date.now());
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
