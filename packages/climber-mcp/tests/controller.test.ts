import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClimberController } from '../src/controller';

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
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET')
        return Response.json({
          ok: true,
          data: { health: { softwareReady: true, deviceConnected: true, deviceBusy: false }, task },
        });
      const body = await request.json();
      writes.push(body);
      task = path.endsWith('/tasks')
        ? { batchId: body.batchId, state: 'READY', experiments: body.experiments }
        : { ...task, state: 'RUNNING' };
      if (uncertain) return new Response('response lost', { status: 500 });
      return Response.json({ ok: true, data: { task } });
    },
  });
  return {
    directory,
    writes,
    create: () => new ClimberController(`${server.url.origin}/api/v1`, 1000, directory),
    uncertain: () => {
      uncertain = true;
    },
    clearTask: () => {
      task = null;
    },
    async close() {
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
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
    expect(f.writes).toHaveLength(2);
    expect(f.writes[0].experiments[0].tubeNo).toBe(37);
    expect(f.writes[1]).toEqual({});
  } finally {
    controller.close();
    await f.close();
  }
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
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(f.writes).toHaveLength(1);
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
    await expect(
      controller.execute(
        'register_batch',
        { batchId: 'B-1', experiments: [experiment] },
        'client-a',
        'OP-1',
      ),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    controller.close();
    controller = f.create();
    f.clearTask();
    await expect(
      controller.execute(
        'register_batch',
        { batchId: 'B-2', experiments: [experiment] },
        'client-b',
        'OP-2',
      ),
    ).rejects.toMatchObject({ code: 'DEVICE_RESERVED' });
    await controller.reconcile('OP-1', 'Operator checked external state');
    expect(controller.db.query('SELECT status FROM operations WHERE id=?').get('OP-1')).toEqual({
      status: 'unknown',
    });
    await expect(
      controller.execute(
        'register_batch',
        { batchId: 'B-1', experiments: [experiment] },
        'client-a',
        'OP-3',
      ),
    ).rejects.toMatchObject({ code: 'REPLAY_BLOCKED' });
    expect(f.writes).toHaveLength(1);
  } finally {
    controller.close();
    await f.close();
  }
});
