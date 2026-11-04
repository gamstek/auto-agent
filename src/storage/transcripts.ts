import type { Database } from 'bun:sqlite';
import type { ToolCall } from '../shared/types';
import type { ToolResult } from '../tool/context';
import { AppError } from '../shared/types';
import { migrate } from './migrations';
import {
  transcriptStatus,
  type RecordedToolDetail,
  type RunTranscript,
  type RunTranscriptEntry,
  type TranscriptRun,
} from './transcript-types';

/** The conversation's private execution transcript, separate from bounded diagnostics. */
export class RunTranscriptStore {
  constructor(private db: Database) {
    migrate(
      db,
      'store-12-conversation-process',
      `CREATE TABLE run_process_entries (
      runId TEXT NOT NULL REFERENCES runs(id), entryId TEXT NOT NULL, kind TEXT NOT NULL,
      name TEXT NOT NULL,status TEXT NOT NULL,step INTEGER,text TEXT NOT NULL DEFAULT '',reasoning TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',detail TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,
      PRIMARY KEY(runId,entryId)
    );`,
    );
  }
  private scope(sessionId: string, runId: string): TranscriptRun {
    const run = this.db
      .query<{ id: string; status: string }, [string, string]>(
        'SELECT id,status FROM runs WHERE sessionId=? AND id=?',
      )
      .get(sessionId, runId);
    if (!run) throw new AppError('run_not_found', 'Run not found in this session', 404);
    return run;
  }
  private ensure(
    runId: string,
    entryId: string,
    kind: RunTranscriptEntry['kind'],
    name: string,
    step?: number,
  ) {
    this.db
      .query(
        `INSERT OR IGNORE INTO run_process_entries
      (runId,entryId,kind,name,status,step,createdAt,updatedAt) VALUES (?,?,?,?,'running',?,?,?)`,
      )
      .run(runId, entryId, kind, name, step ?? null, Date.now(), Date.now());
  }
  recordEvent(runId: string, type: string, data: Record<string, unknown>) {
    const delta = type === 'message.part.delta' || type === 'message.reasoning.delta';
    const model = delta || /^model\.(started|completed|failed)$/.test(type);
    const tool = /^tool\.(started|completed|failed|skipped)$/.test(type);
    if (!model && !tool) return;
    const step = typeof data.step === 'number' ? data.step : undefined;
    const entryId = model ? `model:${step}` : `tool:${data.toolCallId}`;
    this.ensure(
      runId,
      entryId,
      model ? 'model' : 'tool',
      model ? 'model' : String(data.name),
      step,
    );
    if (delta) {
      const field = type === 'message.part.delta' ? 'text' : 'reasoning';
      this.db
        .query(
          `UPDATE run_process_entries SET ${field}=${field}||?,updatedAt=? WHERE runId=? AND entryId=?`,
        )
        .run(String(data.delta ?? ''), Date.now(), runId, entryId);
      return;
    }
    const status = type.endsWith('.started')
      ? 'running'
      : String(data.status ?? (type.endsWith('.completed') ? 'completed' : 'failed'));
    const previous = this.db
      .query<{ metadata: string }, [string, string]>(
        'SELECT metadata FROM run_process_entries WHERE runId=? AND entryId=?',
      )
      .get(runId, entryId)!;
    this.db
      .query(
        'UPDATE run_process_entries SET status=?,metadata=?,updatedAt=? WHERE runId=? AND entryId=?',
      )
      .run(
        status,
        JSON.stringify({ ...JSON.parse(previous.metadata), ...data }),
        Date.now(),
        runId,
        entryId,
      );
  }
  recordModel(runId: string, step: number, text: string, reasoning?: string) {
    const id = `model:${step}`;
    this.ensure(runId, id, 'model', 'model', step);
    this.db
      .query(
        "UPDATE run_process_entries SET text=?,reasoning=?,status='completed',updatedAt=? WHERE runId=? AND entryId=?",
      )
      .run(text, reasoning ?? '', Date.now(), runId, id);
  }
  recordTool(runId: string, call: ToolCall, result?: ToolResult) {
    const id = `tool:${call.id}`;
    this.ensure(runId, id, 'tool', call.name);
    const status = result ? (result.effect === 'unknown' ? 'unknown' : result.status) : 'running';
    this.db
      .query(
        "UPDATE run_process_entries SET detail=?,status=CASE WHEN status='running' THEN ? ELSE status END,updatedAt=? WHERE runId=? AND entryId=?",
      )
      .run(
        JSON.stringify({ input: call.input, ...(result ? { result } : {}) }),
        status,
        Date.now(),
        runId,
        id,
      );
  }
  read(sessionId: string, runId: string): RunTranscript {
    const run = this.scope(sessionId, runId);
    const rows = this.db
      .query<
        Omit<RunTranscriptEntry, 'metadata' | 'hasDetail'> & {
          metadata: string;
          hasDetail: number;
        },
        [string]
      >(
        'SELECT entryId,kind,name,status,step,text,reasoning,metadata,detail IS NOT NULL AS hasDetail FROM run_process_entries WHERE runId=? ORDER BY rowid',
      )
      .all(runId);
    const entries = rows.map(({ metadata, hasDetail, ...row }) => ({
      ...row,
      metadata: JSON.parse(metadata),
      hasDetail: !!hasDetail,
      status: transcriptStatus(row.status, run.status),
    }));
    return { run, entries };
  }
  readDetail(sessionId: string, runId: string, entryId: string): RecordedToolDetail {
    this.scope(sessionId, runId);
    const row = this.db
      .query<{ detail: string | null }, [string, string]>(
        'SELECT detail FROM run_process_entries WHERE runId=? AND entryId=?',
      )
      .get(runId, entryId);
    if (!row?.detail) {
      throw new AppError(
        'process_detail_not_found',
        'This entry has no stored tool input/result',
        404,
      );
    }
    return JSON.parse(row.detail);
  }
}
