import type { Database } from 'bun:sqlite';
import { AppError } from '../shared/types';
import { migrate } from './migrations';

/** Local, authenticated inspection data. Never copied into diagnostic logs. */
export class RunTraceStore {
  constructor(private db: Database) {
    migrate(
      db,
      'store-11-run-traces',
      `
      CREATE TABLE run_trace_graphs (runId TEXT PRIMARY KEY REFERENCES runs(id), graph TEXT NOT NULL);
      CREATE TABLE run_trace_nodes (runId TEXT NOT NULL REFERENCES runs(id), nodeId TEXT NOT NULL,
        kind TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,startedAt INTEGER NOT NULL,finishedAt INTEGER,details TEXT NOT NULL,
        PRIMARY KEY(runId,nodeId));
      CREATE TABLE run_trace_requests (runId TEXT NOT NULL,nodeId TEXT NOT NULL,body TEXT NOT NULL,
        PRIMARY KEY(runId,nodeId),FOREIGN KEY(runId,nodeId) REFERENCES run_trace_nodes(runId,nodeId));
    `,
    );
  }
  private scope(sessionId: string, runId: string) {
    const run = this.db
      .query<{ id: string; status: string }, [string, string]>(
        'SELECT id,status FROM runs WHERE id=? AND sessionId=?',
      )
      .get(runId, sessionId);
    if (!run) throw new AppError('run_not_found', 'Run not found in this session', 404);
    return run;
  }
  list(sessionId: string, limit: number, offset: number) {
    return this.db
      .query(
        'SELECT id,status,messageId,createdAt,finishedAt FROM runs WHERE sessionId=? ORDER BY createdAt DESC,rowid DESC LIMIT ? OFFSET ?',
      )
      .all(sessionId, limit, offset);
  }
  graph(runId: string, graph: unknown) {
    this.db
      .query('INSERT OR REPLACE INTO run_trace_graphs VALUES (?,?)')
      .run(runId, JSON.stringify(graph));
  }
  event(runId: string, type: string, details: Record<string, unknown>) {
    if (!/^(model|tool)\.(started|completed|failed|skipped)$/.test(type)) return;
    const model = type.startsWith('model.');
    const nodeId = model ? `model:${details.step}` : `tool:${details.toolCallId}`;
    const status = type.endsWith('.started')
      ? 'running'
      : String(details.status ?? (type.endsWith('.completed') ? 'completed' : 'failed'));
    this.node(
      runId,
      nodeId,
      model ? 'model' : 'tool',
      model ? `模型 · 第 ${details.step} 轮` : String(details.name),
      status,
      details,
    );
  }
  private node(
    runId: string,
    nodeId: string,
    kind: string,
    label: string,
    status: string,
    details: unknown,
  ) {
    if (nodeId.length > 512)
      throw new AppError('trace_limit', 'Trace node identity exceeds its limit');
    const metadata = JSON.stringify(details);
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO run_trace_nodes VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(runId,nodeId) DO UPDATE SET
      status=excluded.status,finishedAt=excluded.finishedAt,details=excluded.details`,
      )
      .run(
        runId,
        nodeId,
        kind,
        label.slice(0, 256),
        status,
        now,
        status === 'running' ? null : now,
        Buffer.byteLength(metadata) > 8192 ? '{"truncated":true}' : metadata,
      );
  }
  request(runId: string, nodeId: string, kind: 'model' | 'summary', request: unknown) {
    this.node(runId, nodeId, kind, kind === 'summary' ? '上下文摘要' : nodeId, 'running', {});
    const raw = JSON.stringify(request);
    const originalBytes = Buffer.byteLength(raw);
    const used = this.db
      .query<{ bytes: number }, [string]>(
        'SELECT coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM run_trace_requests WHERE runId=?',
      )
      .get(runId)!.bytes;
    // Bound inspection storage separately from execution context; truncation is explicit.
    const body =
      used + originalBytes > 32 * 1024 * 1024
        ? { truncated: true, originalBytes, reason: 'run_snapshot_limit' }
        : originalBytes > 4 * 1024 * 1024
          ? {
              truncated: true,
              originalBytes,
              reason: 'request_snapshot_limit',
              preview: raw.slice(0, 65536),
            }
          : { truncated: false, originalBytes, request };
    this.db
      .query('INSERT OR REPLACE INTO run_trace_requests VALUES (?,?,?)')
      .run(runId, nodeId, JSON.stringify(body));
  }
  finish(runId: string, nodeId: string, status: string) {
    this.db
      .query('UPDATE run_trace_nodes SET status=?,finishedAt=? WHERE runId=? AND nodeId=?')
      .run(status, Date.now(), runId, nodeId);
  }
  read(sessionId: string, runId: string) {
    const run = this.scope(sessionId, runId);
    const graph = this.db
      .query<{ graph: string }, [string]>('SELECT graph FROM run_trace_graphs WHERE runId=?')
      .get(runId);
    const nodes = this.db
      .query<
        {
          nodeId: string;
          kind: string;
          label: string;
          status: string;
          startedAt: number;
          finishedAt: number | null;
          details: string;
          hasRequest: number;
        },
        [string]
      >(
        `SELECT n.nodeId,n.kind,n.label,n.status,n.startedAt,n.finishedAt,n.details,
       EXISTS(SELECT 1 FROM run_trace_requests r WHERE r.runId=n.runId AND r.nodeId=n.nodeId) AS hasRequest
       FROM run_trace_nodes n WHERE n.runId=? ORDER BY n.rowid`,
      )
      .all(runId)
      .map(({ details, hasRequest, ...node }) => ({
        ...node,
        status: node.status === 'running' && run.status !== 'running' ? 'interrupted' : node.status,
        details: JSON.parse(details),
        hasRequest: !!hasRequest,
      }));
    return { run, graph: graph ? JSON.parse(graph.graph) : null, nodes };
  }
  readRequest(sessionId: string, runId: string, nodeId: string) {
    this.scope(sessionId, runId);
    const row = this.db
      .query<{ body: string }, [string, string]>(
        'SELECT body FROM run_trace_requests WHERE runId=? AND nodeId=?',
      )
      .get(runId, nodeId);
    if (!row)
      throw new AppError('trace_not_found', 'No model request snapshot exists for this node', 404);
    return JSON.parse(row.body);
  }
}
