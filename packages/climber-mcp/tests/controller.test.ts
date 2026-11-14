import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClimberController } from '../src/controller';
import { resultSchema } from '../src/vendor';

const experiment = {
  experimentId: 'EXP-1',
  analysisPort: 1,
  tubeNo: 109,
  samPath: 'E:\\templates\\sample.SAM',
  sampleName: 'Sample',
  emptyTubeMassG: 29.1,
  sampleMassG: 1.5,
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'climber-mcp-test-'));
  let task: any = null,
    uncertain = false;
  const writes: any[] = [];
  const server = createServer(async (request, response) => {
    const path = request.url ?? '/';
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET') {
      response.end(
        JSON.stringify({
          ok: true,
          data: { health: { softwareReady: true, deviceConnected: true, deviceBusy: false }, task },
        }),
      );
      return;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    writes.push(body);
    task = path.endsWith('/tasks')
      ? {
          batchId: body.batchId,
          state: 'READY',
          experiments: body.experiments.map((entry: typeof experiment) => ({
            ...entry,
            deviceRunId: '',
          })),
        }
      : { ...task, state: 'RUNNING' };
    response.statusCode = uncertain ? 500 : 200;
    response.end(uncertain ? 'response lost' : JSON.stringify({ ok: true, data: { task } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    directory,
    writes,
    create: () =>
      new ClimberController(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`,
        1000,
        directory,
      ),
    uncertain: () => {
      uncertain = true;
    },
    clearTask: () => {
      task = null;
    },
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await rm(directory, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

test('batch control works for standard callers without an Agent or skill identity', async () => {
  const f = await fixture(),
    controller = f.create();
  try {
    await controller.execute(
      'register_batch',
      { batchId: 'B-1', experiments: [experiment] },
      'client-a',
      'OP-1',
    );
    await controller.execute('start_batch', { batchId: 'B-1' }, 'client-b', 'OP-2');
    assert.equal(f.writes.length, 2);
    assert.equal(f.writes[0].experiments[0].tubeNo, 37);
    assert.deepEqual(f.writes[1], {});
  } finally {
    controller.close();
    await f.close();
  }
});

test('registration and READY status preserve an empty deviceRunId without an unknown write', async () => {
  const f = await fixture();
  const controller = f.create();
  try {
    const registered = await controller.execute(
      'register_batch',
      { batchId: 'B-EMPTY-RUN', experiments: [experiment] },
      'client-a',
      'OP-EMPTY-RUN',
    );
    assert.equal(registered.task?.experiments?.[0]?.deviceRunId, '');
    assert.equal(resultSchema.parse(registered).task?.state, 'READY');
    const status = await controller.execute('get_status', {}, 'client-a');
    assert.equal(status.task?.experiments?.[0]?.deviceRunId, '');
    assert.equal(resultSchema.parse(status).task?.batchId, 'B-EMPTY-RUN');
    assert.equal(
      controller.db.prepare('SELECT status FROM operations WHERE id=?').get('OP-EMPTY-RUN')?.status,
      'confirmed',
    );
    assert.equal(f.writes.length, 1);
  } finally {
    controller.close();
    await f.close();
  }
});

test('deviceRunId accepts empty, absent, null, numeric and valid text values only', () => {
  const result = (deviceRunId: unknown) => ({
    source: 'climber-vendor',
    operation: 'get_status',
    task: {
      batchId: 'B-1',
      state: 'READY',
      experiments: [{ experimentId: 'EXP-1', deviceRunId }],
    },
  });
  for (const value of ['', undefined, null, 123, 'run-1'])
    assert.equal(resultSchema.parse(result(value)).task?.experiments?.[0]?.deviceRunId, value);
  for (const value of [' ', '\n', 'x'.repeat(129), {}, true])
    assert.equal(resultSchema.safeParse(result(value)).success, false);
});

test('independent server instances cannot register concurrent batches on the same endpoint', async () => {
  const f = await fixture(),
    a = f.create(),
    b = f.create();
  try {
    const results = await Promise.allSettled([
      a.execute(
        'register_batch',
        { batchId: 'B-1', experiments: [experiment] },
        'client-a',
        'OP-1',
      ),
      b.execute(
        'register_batch',
        { batchId: 'B-2', experiments: [experiment] },
        'client-b',
        'OP-2',
      ),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(f.writes.length, 1);
  } finally {
    a.close();
    b.close();
    await f.close();
  }
});

test('server persists uncertain reservations, requires review and never replays the uncertain batch', async () => {
  const f = await fixture();
  f.uncertain();
  let controller = f.create();
  try {
    await assert.rejects(
      controller.execute(
        'register_batch',
        { batchId: 'B-1', experiments: [experiment] },
        'client-a',
        'OP-1',
      ),
      { outcome: 'unknown' },
    );
    controller.close();
    controller = f.create();
    f.clearTask();
    await assert.rejects(
      controller.execute(
        'register_batch',
        { batchId: 'B-2', experiments: [experiment] },
        'client-b',
        'OP-2',
      ),
      { code: 'DEVICE_RESERVED' },
    );
    await controller.reconcile('OP-1', 'Operator checked external state');
    assert.deepEqual(
      { ...controller.db.prepare('SELECT status FROM operations WHERE id=?').get('OP-1') },
      {
        status: 'unknown',
      },
    );
    await assert.rejects(
      controller.execute(
        'register_batch',
        { batchId: 'B-1', experiments: [experiment] },
        'client-a',
        'OP-3',
      ),
      { code: 'REPLAY_BLOCKED' },
    );
    assert.equal(f.writes.length, 1);
  } finally {
    controller.close();
    await f.close();
  }
});
