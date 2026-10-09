import type { Database } from 'bun:sqlite';
import {
  BaseCheckpointSaver,
  WRITES_IDX_MAP,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import { AppError } from '../shared/types';
import { migrate } from './migrations';

type Config = CheckpointTuple['config'];
interface CheckpointRow {
  threadId: string;
  namespace: string;
  id: string;
  parentId: string | null;
  checkpointType: string;
  checkpoint: Uint8Array;
  metadataType: string;
  metadata: Uint8Array;
}
interface WriteRow {
  taskId: string;
  channel: string;
  type: string;
  value: Uint8Array;
}

function identifier(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value)) {
    throw new AppError('INVALID_CHECKPOINT_CONFIG', `${field} must be a string identifier.`);
  }
  return value;
}

function key(config: Config): [string, string, string | undefined] {
  const c = config.configurable;
  return [
    identifier(c?.thread_id, 'thread_id'),
    identifier(c?.checkpoint_ns ?? '', 'checkpoint_ns', true),
    c?.checkpoint_id === undefined ? undefined : identifier(c.checkpoint_id, 'checkpoint_id'),
  ];
}

function checkpointConfig(threadId: string, namespace: string, id: string): Config {
  return { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: id } };
}

export class SQLiteSaver extends BaseCheckpointSaver {
  constructor(
    readonly db: Database,
    serde?: SerializerProtocol,
  ) {
    super(serde);
    migrate(
      db,
      'checkpoints-1',
      `
      CREATE TABLE checkpoints (
        threadId TEXT NOT NULL, namespace TEXT NOT NULL, id TEXT NOT NULL, parentId TEXT,
        checkpointType TEXT NOT NULL, checkpoint BLOB NOT NULL,
        metadataType TEXT NOT NULL, metadata BLOB NOT NULL,
        PRIMARY KEY(threadId, namespace, id)
      );
      CREATE TABLE checkpoint_writes (
        threadId TEXT NOT NULL, namespace TEXT NOT NULL, checkpointId TEXT NOT NULL,
        taskId TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL,
        type TEXT NOT NULL, value BLOB NOT NULL,
        PRIMARY KEY(threadId, namespace, checkpointId, taskId, idx)
      );
    `,
    );
  }

  private async tuple(row: CheckpointRow): Promise<CheckpointTuple> {
    const writes = this.db
      .query<WriteRow, [string, string, string]>(
        'SELECT taskId, channel, type, value FROM checkpoint_writes WHERE threadId = ? AND namespace = ? AND checkpointId = ? ORDER BY taskId, idx',
      )
      .all(row.threadId, row.namespace, row.id);
    const [checkpoint, metadata, pendingWrites] = await Promise.all([
      this.serde.loadsTyped(row.checkpointType, row.checkpoint),
      this.serde.loadsTyped(row.metadataType, row.metadata),
      Promise.all(
        writes.map(async (write): Promise<[string, string, unknown]> => [
          write.taskId,
          write.channel,
          await this.serde.loadsTyped(write.type, write.value),
        ]),
      ),
    ]);
    return {
      config: checkpointConfig(row.threadId, row.namespace, row.id),
      checkpoint,
      metadata,
      pendingWrites,
      ...(row.parentId === null
        ? {}
        : { parentConfig: checkpointConfig(row.threadId, row.namespace, row.parentId) }),
    };
  }

  async getTuple(config: Config): Promise<CheckpointTuple | undefined> {
    const [threadId, namespace, id] = key(config);
    const row =
      id === undefined
        ? this.db
            .query<CheckpointRow, [string, string]>(
              'SELECT * FROM checkpoints WHERE threadId = ? AND namespace = ? ORDER BY id DESC LIMIT 1',
            )
            .get(threadId, namespace)
        : this.db
            .query<CheckpointRow, [string, string, string]>(
              'SELECT * FROM checkpoints WHERE threadId = ? AND namespace = ? AND id = ?',
            )
            .get(threadId, namespace, id);
    return row ? this.tuple(row) : undefined;
  }

  async *list(
    config: Config,
    options: CheckpointListOptions = {},
  ): AsyncGenerator<CheckpointTuple> {
    const clauses: string[] = [];
    const params: string[] = [];
    for (const [field, value, allowEmpty] of [
      ['threadId', config.configurable?.thread_id, false],
      ['namespace', config.configurable?.checkpoint_ns, true],
      ['id', config.configurable?.checkpoint_id, false],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${field} = ?`);
        params.push(identifier(value, field, allowEmpty));
      }
    }
    if (options.before?.configurable?.checkpoint_id !== undefined) {
      clauses.push('id < ?');
      params.push(identifier(options.before.configurable.checkpoint_id, 'checkpoint_id'));
    }
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new AppError(
        'INVALID_CHECKPOINT_LIMIT',
        'Checkpoint limit must be a nonnegative integer.',
      );
    }
    const rows = this.db
      .query<CheckpointRow, string[]>(
        `SELECT * FROM checkpoints ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC, threadId, namespace`,
      )
      .all(...params);
    let count = 0;
    for (const row of rows) {
      if (options.limit !== undefined && count >= options.limit) break;
      const tuple = await this.tuple(row);
      if (
        options.filter &&
        !Object.entries(options.filter).every(
          ([field, value]) =>
            Object.hasOwn(tuple.metadata ?? {}, field) &&
            equal((tuple.metadata as Record<string, unknown>)[field], value),
        )
      )
        continue;
      count++;
      yield tuple;
    }
  }

  async put(
    config: Config,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: ChannelVersions,
  ): Promise<Config> {
    const [threadId, namespace, parentId] = key(config);
    const id = identifier(checkpoint.id, 'checkpoint.id');
    const [[checkpointType, bytes], [metadataType, metadataBytes]] = await Promise.all([
      this.serde.dumpsTyped(checkpoint),
      this.serde.dumpsTyped(metadata),
    ]);
    this.db
      .query(
        `INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(threadId, namespace, id) DO UPDATE SET
        parentId = excluded.parentId, checkpointType = excluded.checkpointType,
        checkpoint = excluded.checkpoint, metadataType = excluded.metadataType, metadata = excluded.metadata`,
      )
      .run(
        threadId,
        namespace,
        id,
        parentId ?? null,
        checkpointType,
        bytes,
        metadataType,
        metadataBytes,
      );
    return checkpointConfig(threadId, namespace, id);
  }

  async putWrites(config: Config, writes: PendingWrite[], taskId: string): Promise<void> {
    const [threadId, namespace, checkpointId] = key(config);
    if (checkpointId === undefined)
      throw new AppError('INVALID_CHECKPOINT_CONFIG', 'checkpoint_id is required for writes.');
    identifier(taskId, 'task_id');
    const serialized = await Promise.all(
      writes.map(async ([channel, value], index) => {
        const [type, bytes] = await this.serde.dumpsTyped(value);
        const idx = Object.hasOwn(WRITES_IDX_MAP, channel) ? WRITES_IDX_MAP[channel]! : index;
        return { channel, type, bytes, idx };
      }),
    );
    this.db
      .transaction(() => {
        for (const write of serialized) {
          // Ordinary writes are first-write-wins; special negative slots are replaceable.
          const conflict =
            write.idx < 0
              ? 'DO UPDATE SET channel = excluded.channel, type = excluded.type, value = excluded.value'
              : 'DO NOTHING';
          this.db
            .query(
              `INSERT INTO checkpoint_writes VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(threadId, namespace, checkpointId, taskId, idx) ${conflict}`,
            )
            .run(
              threadId,
              namespace,
              checkpointId,
              taskId,
              write.idx,
              write.channel,
              write.type,
              write.bytes,
            );
        }
      })
      .immediate();
  }

  async deleteThread(threadId: string): Promise<void> {
    identifier(threadId, 'thread_id');
    this.db
      .transaction(() => {
        this.db.query('DELETE FROM checkpoint_writes WHERE threadId = ?').run(threadId);
        this.db.query('DELETE FROM checkpoints WHERE threadId = ?').run(threadId);
      })
      .immediate();
  }
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a),
    right = Object.keys(b);
  return (
    left.length === right.length &&
    left.every(
      (field) =>
        Object.hasOwn(b, field) &&
        equal((a as Record<string, unknown>)[field], (b as Record<string, unknown>)[field]),
    )
  );
}
