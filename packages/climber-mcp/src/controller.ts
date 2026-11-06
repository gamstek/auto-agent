import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { callVendor, inputs, VendorError, type ClimberResult, type ClimberTool } from './vendor';

type Claim = { batchId: string; owner: string; phase: string; operationId: string };
/** Manufacturer semantics and persistent equipment ownership belong to this server. */
export class ClimberController {
  readonly db: DatabaseSync;
  constructor(
    private baseURL: string,
    private timeoutMs: number,
    directory: string,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const identity = createHash('sha256')
      .update(new URL(baseURL).href.replace(/\/$/, ''))
      .digest('hex');
    this.db = new DatabaseSync(join(directory, `${identity}.sqlite`));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,batchId TEXT NOT NULL,stage TEXT NOT NULL,owner TEXT NOT NULL,pid INTEGER NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS operations_batch ON operations(batchId,stage,status);
      CREATE TABLE IF NOT EXISTS claim(id INTEGER PRIMARY KEY CHECK(id=1),batchId TEXT NOT NULL,owner TEXT NOT NULL,phase TEXT NOT NULL,operationId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(operationId TEXT PRIMARY KEY,note TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
  }
  private claim() {
    return this.db.prepare('SELECT * FROM claim WHERE id=1').get() as Claim | undefined;
  }
  private immediate<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
  }
  async execute(
    name: ClimberTool,
    raw: unknown,
    owner: string,
    operationId: string = randomUUID(),
    signal?: AbortSignal,
  ): Promise<ClimberResult> {
    const input = inputs[name].parse(raw);
    if (name.startsWith('get_')) {
      const result = await callVendor(name, input, this.baseURL, this.timeoutMs, signal);
      const claim = this.claim();
      if (
        name === 'get_status' &&
        claim?.phase === 'running' &&
        result.task?.batchId === claim.batchId &&
        result.task.state === 'COMPLETED' &&
        result.health?.deviceBusy === false
      )
        this.db
          .prepare("DELETE FROM claim WHERE id=1 AND phase='running' AND batchId=?")
          .run(claim.batchId);
      return result;
    }
    const batchId = (input as { batchId: string }).batchId;
    // Reads can be retried by the caller. No write has been dispatched at this point.
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner) || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId))
      throw new VendorError('INVALID_IDENTITY', '调用身份无效', 'rejected');
    let current: ClimberResult;
    try {
      current = await callVendor('get_status', {}, this.baseURL, this.timeoutMs, signal);
    } catch {
      throw new VendorError(
        'PRECONDITION_UNAVAILABLE',
        '前置状态查询失败，未发送设备写入',
        'rejected',
      );
    }
    if (
      current.health?.softwareReady !== true ||
      current.health.deviceConnected !== true ||
      current.health.deviceBusy !== false
    )
      throw new VendorError('DEVICE_NOT_READY', '无法确认仪器已连接、就绪且空闲', 'rejected');
    if (
      name === 'start_batch' &&
      (current.task?.batchId !== batchId || current.task?.state !== 'READY')
    )
      throw new VendorError('TASK_CONFLICT', '当前任务不是已登记且处于 READY 的批次', 'rejected');
    if (name === 'register_batch' && current.task && current.task.state !== 'COMPLETED')
      throw new VendorError('TASK_CONFLICT', '厂家已有未完成任务', 'rejected');
    signal?.throwIfAborted();
    this.immediate(() => {
      if (this.db.prepare('SELECT id FROM operations WHERE id=?').get(operationId))
        throw new VendorError('REPLAY_BLOCKED', '操作标识已使用', 'rejected');
      if (
        this.db
          .prepare(
            "SELECT id FROM operations WHERE batchId=? AND status IN ('unknown','dispatching')",
          )
          .get(batchId)
      )
        throw new VendorError('REPLAY_BLOCKED', '此批次存在未确认写入，不允许重发', 'rejected');
      const claim = this.claim();
      if (name === 'register_batch') {
        if (claim) throw new VendorError('DEVICE_RESERVED', '仪器已被预留或等待核对', 'rejected');
        if (
          this.db
            .prepare(
              "SELECT id FROM operations WHERE batchId=? AND stage='register_batch' AND status='confirmed'",
            )
            .get(batchId)
        )
          throw new VendorError('REPLAY_BLOCKED', '批次标识已经使用', 'rejected');
        this.db
          .prepare("INSERT INTO claim VALUES (1,?,?,'registering',?)")
          .run(batchId, owner, operationId);
      } else {
        if (!claim || claim.batchId !== batchId || claim.phase !== 'registered')
          throw new VendorError('DEVICE_RESERVED', '需要本批次明确成功的登记记录', 'rejected');
        this.db
          .prepare("UPDATE claim SET phase='starting',operationId=? WHERE id=1")
          .run(operationId);
      }
      this.db
        .prepare("INSERT INTO operations VALUES (?,?,?,?,?,'dispatching',?)")
        .run(operationId, batchId, name, owner, process.pid, Date.now());
    });
    let status: 'confirmed' | 'rejected' | 'unknown' = 'unknown';
    let result: ClimberResult | undefined, error: unknown;
    try {
      result = await callVendor(name, input, this.baseURL, this.timeoutMs, signal);
      status = 'confirmed';
    } catch (cause) {
      error = cause;
      if (cause instanceof VendorError && cause.outcome === 'rejected') status = 'rejected';
    }
    try {
      this.immediate(() => {
        this.db.prepare('UPDATE operations SET status=? WHERE id=?').run(status, operationId);
        if (status === 'rejected' && name === 'register_batch')
          this.db.prepare('DELETE FROM claim WHERE id=1 AND operationId=?').run(operationId);
        else
          this.db
            .prepare('UPDATE claim SET phase=? WHERE id=1 AND operationId=?')
            .run(
              status === 'unknown'
                ? 'unknown'
                : status === 'rejected' || name === 'register_batch'
                  ? 'registered'
                  : 'running',
              operationId,
            );
      });
    } catch {
      throw new VendorError('OUTCOME_UNKNOWN', '无法保存设备操作结果，不得重发', 'unknown');
    }
    if (status === 'unknown')
      throw new VendorError(
        'OUTCOME_UNKNOWN',
        `设备写入效果未知，保留操作 ${operationId} 与批次核对`,
        'unknown',
      );
    if (error) throw error;
    return result!;
  }
  async reconcile(operationId: string, note: string, signal?: AbortSignal) {
    if (!note.trim() || Buffer.byteLength(note) > 2000)
      throw new VendorError('INVALID_REVIEW', '需要有界的操作者核对说明', 'rejected');
    const operation = this.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId) as
      { status: string; pid: number; batchId: string } | undefined;
    if (!operation) throw new VendorError('INVALID_REVIEW', '操作不存在', 'rejected');
    if (operation.status === 'dispatching') {
      let alive = true;
      try {
        process.kill(operation.pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (alive)
        throw new VendorError(
          'OPERATION_ACTIVE',
          '原操作进程可能仍在执行，不能释放预留',
          'rejected',
        );
    }
    const current = await callVendor('get_status', {}, this.baseURL, this.timeoutMs, signal);
    if (
      current.health?.deviceBusy !== false ||
      current.task === undefined ||
      (current.task && current.task.state !== 'COMPLETED')
    )
      throw new VendorError('REVIEW_BLOCKED', '需要新鲜空闲状态且无未完成任务', 'rejected');
    this.immediate(() => {
      const claim = this.claim();
      if (claim && claim.operationId !== operationId)
        throw new VendorError('REVIEW_CONFLICT', '当前预留属于另一操作', 'rejected');
      this.db.prepare('INSERT INTO reviews VALUES (?,?,?)').run(operationId, note, Date.now());
      if (operation.status === 'dispatching')
        this.db.prepare("UPDATE operations SET status='unknown' WHERE id=?").run(operationId);
      this.db.prepare('DELETE FROM claim WHERE id=1 AND operationId=?').run(operationId);
    });
    return {
      reconciled: true,
      operationId,
      originalOutcome: operation.status === 'dispatching' ? 'unknown' : operation.status,
    };
  }
  close() {
    this.db.close();
  }
}
