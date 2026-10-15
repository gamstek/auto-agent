import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const script = resolve('skills/device-automation/scripts/climber.js');
const node = Bun.which('node');
if (!node) throw new Error('Node.js is required for portable skill script tests.');
const submission = () => ({
  commandId: 'CMD-001',
  payload: {
    taskId: 'BATCH-001',
    stationId: 'analyzer-02',
    experiments: [
      {
        experimentId: 'EXP-001',
        analysisPort: 1,
        tubeNo: 109,
        samPath: '//server/share/existing.SAM',
        sampleName: '样品A',
        emptyTubeMassG: 29.1,
        sampleMassG: 1.5,
      },
    ],
  },
});

async function run(
  url: string,
  command: string,
  input?: unknown,
  timeout = '5000',
  runtime = node!,
) {
  const child = Bun.spawn(
    [runtime, script, command, ...(input === undefined ? [] : [JSON.stringify(input)])],
    {
      env: { CLIMBER_SERVICE_URL: url, CLIMBER_TIMEOUT_MS: timeout },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe('');
  return { code, value: JSON.parse(stdout) };
}

test('Climber portable script preserves service commands, raw tube numbers and state/result evidence', async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let taskState = 'STARTING';
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : undefined;
      calls.push({ path, method: request.method, body });
      if (path === '/commands')
        return Response.json(
          { commandId: body.commandId, accepted: true, workStatus: 'BUSY' },
          { status: 202 },
        );
      if (path === '/api/v1/status')
        return Response.json({
          ok: true,
          data: { health: {}, task: { batchId: 'BATCH-001', state: taskState } },
        });
      if (path === '/results')
        return Response.json({ archiveStatus: 'PENDING', pendingNotifications: 0 });
      return Response.json({ workStatus: 'IDLE' });
    },
  });
  try {
    for (const [command, path] of [
      ['health', '/health'],
      ['status', '/status'],
      ['vendor-health', '/api/v1/health'],
    ]) {
      expect((await run(server.url.origin, command!)).code).toBe(0);
      expect(calls.at(-1)).toEqual({ path, method: 'GET', body: undefined });
    }
    const input = submission();
    const started = await run(server.url.origin, 'start', input);
    expect(started.code).toBe(0);
    expect(started.value).toMatchObject({
      backend: 'climber-subservice',
      taskId: 'BATCH-001',
      response: { accepted: true },
    });
    expect(calls.at(-1)).toEqual({
      path: '/commands',
      method: 'POST',
      body: { ...input, commandType: 'CLIMBER_ANALYZER_START' },
    });
    for (const state of ['STARTING', 'RUNNING', 'COMPLETED']) {
      taskState = state;
      const status = await run(server.url.origin, 'vendor-status');
      expect(status.value.response.data.task.state).toBe(state);
    }
    // The same script also runs under the application's compatible Bun runtime.
    const results = await run(server.url.origin, 'results', undefined, '5000', process.execPath);
    expect(results.code).toBe(0);
    expect(results.value.response.archiveStatus).toBe('PENDING');
    for (const [command, commandType] of [
      ['resume', 'RESUME'],
      ['clear-error', 'CLEAR_ERROR'],
      ['status-poll', 'STATUS_POLL'],
    ]) {
      expect(
        (await run(server.url.origin, command!, { commandId: 'LOCAL-1', payload: {} })).code,
      ).toBe(0);
      expect(calls.at(-1)?.body).toEqual({ commandId: 'LOCAL-1', commandType, payload: {} });
    }
    expect(calls.every((call) => call.path !== '/tasks')).toBe(true);
  } finally {
    server.stop(true);
  }
});

test('Climber rejects unsupported fields, right ports, invalid masses/paths and modulo collisions before HTTP', async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return Response.json({});
    },
  });
  try {
    const invalid: unknown[] = [];
    for (const patch of [
      { analysisPort: 4 },
      { tubeNo: 0 },
      { sampleMassG: 0 },
      { samPath: 'existing.SAM' },
      { sampleName: 'bad/name' },
      { tubeCode: '00109' },
    ]) {
      const input = submission();
      Object.assign(input.payload.experiments[0]!, patch);
      invalid.push(input);
    }
    const collision = submission();
    collision.payload.experiments.push({
      ...collision.payload.experiments[0]!,
      experimentId: 'EXP-002',
      analysisPort: 2,
      tubeNo: 37,
    });
    invalid.push(collision, { ...submission(), extra: true });
    for (const input of invalid) {
      const result = await run(server.url.origin, 'start', input);
      expect(result.code).not.toBe(0);
      expect(result.value.error.code).toBe('INVALID_INPUT');
    }
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
  }
});

test('Climber distinguishes rejection from uncertain effects without retrying writes', async () => {
  let requests = 0;
  let mode = 'rejected';
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requests++;
      if (mode === 'timeout') {
        await Bun.sleep(150);
        return Response.json({});
      }
      if (mode === 'invalid') return new Response('not JSON');
      if (mode === 'identity')
        return Response.json({ commandId: 'OTHER', accepted: true, workStatus: 'BUSY' });
      return Response.json(
        {
          commandId: 'CMD-001',
          accepted: false,
          workStatus: 'IDLE',
          error: { code: 'LOCAL_CONTROL_CONFLICT', message: 'window occupied' },
        },
        { status: 409 },
      );
    },
  });
  try {
    for (const value of ['rejected', 'identity', 'invalid', 'timeout']) {
      mode = value;
      const before = requests;
      const result = await run(
        server.url.origin,
        'start',
        submission(),
        value === 'timeout' ? '50' : '5000',
      );
      expect(result.code).not.toBe(0);
      expect(result.value.error.code).toBe(
        value === 'rejected' ? 'COMMAND_REJECTED' : 'OUTCOME_UNKNOWN',
      );
      expect(result.value.error.commandId).toBe('CMD-001');
      expect(result.value.error.taskId).toBe('BATCH-001');
      if (value === 'rejected')
        expect(result.value.error.response.error.code).toBe('LOCAL_CONTROL_CONFLICT');
      if (value === 'timeout') {
        // The deadline also covers connection setup: a slow CI runner may abort
        // before the request reaches the server. Either outcome must not retry.
        expect(requests - before).toBeLessThanOrEqual(1);
      } else {
        expect(requests - before).toBe(1);
      }
    }
  } finally {
    server.stop(true);
  }
});
