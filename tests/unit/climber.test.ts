import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const script = resolve('skills/device-automation/scripts/climber.js');
const node = Bun.which('node');
if (!node) throw new Error('Node.js is required for portable skill script tests.');
const submission = () => ({
  batchId: 'BATCH-001',
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
});

async function run(
  url: string,
  command: string,
  input?: unknown,
  timeout = '5000',
  runtime = node!,
) {
  const { stdout, stderr, code, signal } = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const child = spawn(
      runtime,
      [script, command, ...(input === undefined ? [] : [JSON.stringify(input)])],
      {
        env: {
          CLIMBER_SERVICE_URL: url,
          CLIMBER_TIMEOUT_MS: timeout,
          SystemRoot: process.env.SystemRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    // close follows stdio closure, unlike process exit. Collect complete output
    // before parsing, including for CLI validations that exit immediately.
    child.once('close', (code, signal) => resolve({ stdout, stderr, code, signal }));
  });
  if (!stdout.trim())
    throw new Error(
      `Climber ${command} produced no JSON (exit=${code}, signal=${signal}, stderr=${JSON.stringify(stderr)})`,
    );
  expect(signal).toBeNull();
  expect(stderr).toBe('');
  expect(stdout.trim().split('\n')).toHaveLength(1);
  return { code, value: JSON.parse(stdout) };
}

test('Climber uses only manufacturer routes, normalizes tube numbers and separates registration from start', async () => {
  const calls: { path: string; method: string; body: any }[] = [];
  const health = { softwareReady: true, deviceConnected: true, deviceBusy: false };
  let task: any = null;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === 'POST' ? await request.json() : undefined;
      calls.push({ path, method: request.method, body });
      if (path === '/api/v1/health') return Response.json({ ok: true, data: health });
      if (path === '/api/v1/status') return Response.json({ ok: true, data: { health, task } });
      if (path === '/api/v1/tasks') {
        task = { batchId: body.batchId, state: 'READY', experiments: body.experiments };
        return Response.json({ ok: true, data: { task } }, { status: 201 });
      }
      if (path === '/api/v1/tasks/BATCH-001/start') {
        task = { ...task, state: 'STARTING', analysisStarted: false };
        return Response.json({ ok: true, data: task }, { status: 202 });
      }
      return Response.json(
        { ok: false, error: { code: 'UNEXPECTED_ROUTE', message: path } },
        { status: 404 },
      );
    },
  });
  try {
    const base = `${server.url.origin}/api/v1`;
    for (const url of [base, `${base}/`]) {
      expect((await run(url, 'health')).value.response.data).toEqual(health);
      expect(calls.at(-1)).toEqual({ path: '/api/v1/health', method: 'GET', body: undefined });
    }
    expect((await run(base, 'status')).value.response.data.task).toBeNull();
    const input = submission();
    input.experiments.push({
      ...input.experiments[0]!,
      experimentId: 'EXP-002',
      analysisPort: 2,
      tubeNo: 144,
    });
    const registered = await run(base, 'register', input);
    expect(registered.code).toBe(0);
    expect(registered.value).toMatchObject({
      backend: 'climber-vendor',
      operation: 'register',
      batchId: 'BATCH-001',
      response: { data: { task: { state: 'READY' } } },
    });
    expect(registered.value.tubeMapping).toEqual([
      { experimentId: 'EXP-001', tubeNo: 109, vendorTubeNo: 37 },
      { experimentId: 'EXP-002', tubeNo: 144, vendorTubeNo: 72 },
    ]);
    expect(calls.at(-1)).toEqual({
      path: '/api/v1/tasks',
      method: 'POST',
      body: {
        batchId: input.batchId,
        experiments: input.experiments.map((e, i) => ({ ...e, tubeNo: [37, 72][i] })),
      },
    });
    expect(calls.filter((call) => call.path.endsWith('/start'))).toHaveLength(0);
    const started = await run(base, 'start', { batchId: input.batchId });
    expect(started.code).toBe(0);
    expect(started.value.response.data).toMatchObject({
      batchId: input.batchId,
      state: 'STARTING',
      analysisStarted: false,
    });
    expect(calls.at(-1)).toEqual({
      path: '/api/v1/tasks/BATCH-001/start',
      method: 'POST',
      body: {},
    });
    for (const state of ['STARTING', 'RUNNING', 'COMPLETED']) {
      task.state = state;
      const status = await run(base, 'status', undefined, '5000', process.execPath);
      expect(status.code).toBe(0);
      expect(status.value.response.data.task.state).toBe(state);
      expect(status.value.response.data.task.experiments[0].experimentId).toBe('EXP-001');
    }
    expect(calls.every((call) => call.path.startsWith('/api/v1/'))).toBe(true);
  } finally {
    server.stop(true);
  }
}, 30000);

test('Climber rejects invalid vendor inputs and removed subservice commands before HTTP', async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return Response.json({});
    },
  });
  const base = `${server.url.origin}/api/v1`;
  try {
    const invalid: unknown[] = [];
    for (const patch of [
      { analysisPort: 4 },
      { tubeNo: 0 },
      { tubeNo: Number.MAX_SAFE_INTEGER + 1 },
      { sampleMassG: 0 },
      { samPath: 'existing.SAM' },
      { sampleName: 'bad/name' },
      { tubeCode: '00109' },
    ]) {
      const input = submission();
      Object.assign(input.experiments[0]!, patch);
      invalid.push(input);
    }
    const collision = submission();
    collision.experiments.push({
      ...collision.experiments[0]!,
      experimentId: 'EXP-002',
      analysisPort: 2,
      tubeNo: 37,
    });
    invalid.push(
      collision,
      { ...submission(), extra: true },
      { commandId: 'old', payload: { taskId: 'old', stationId: 'old', experiments: [] } },
    );
    for (const batchId of ['.', '..', 'bad/id', '', 'A'.repeat(65)])
      invalid.push({ ...submission(), batchId });
    for (const input of invalid)
      expect((await run(base, 'register', input)).value.error.code).toBe('INVALID_INPUT');
    expect((await run(base, 'start', submission())).value.error.code).toBe('INVALID_INPUT');
    for (const command of [
      'vendor-health',
      'vendor-status',
      'results',
      'resume',
      'clear-error',
      'status-poll',
    ])
      expect((await run(base, command)).value.error.code).toBe('INVALID_COMMAND');
    for (const url of [
      server.url.origin,
      `${server.url.origin}/api/v1/health`,
      `${base}?x=1`,
      `${base}#fragment`,
      `${server.url.origin.replace('http://', 'http://user:password@')}/api/v1`,
    ])
      expect((await run(url, 'health')).value.error.code).toBe('INVALID_CONFIGURATION');
    expect((await run(base, 'health', {})).value.error.code).toBe('INVALID_ARGUMENTS');
    expect((await run(base, 'health', undefined, '0')).value.error.code).toBe(
      'INVALID_CONFIGURATION',
    );
    expect(requests).toBe(0);
  } finally {
    server.stop(true);
  }
}, 30000);

test('Climber preserves batch and stage for uncertain registration/start and never retries a write', async () => {
  let requests = 0;
  let mode = 'rejected';
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      requests++;
      if (mode === 'timeout') {
        await Bun.sleep(150);
        return Response.json({});
      }
      if (mode === 'invalid') return new Response('not JSON');
      if (mode === 'rejected')
        return Response.json(
          { ok: false, error: { code: 'LOCAL_CONTROL_CONFLICT', message: 'window occupied' } },
          { status: 409 },
        );
      const task = { batchId: mode === 'identity' ? 'OTHER' : 'BATCH-001', state: 'STARTING' };
      const register = new URL(request.url).pathname === '/api/v1/tasks';
      const data = register !== (mode === 'envelope') ? { task } : task;
      return Response.json({ ok: true, data }, { status: mode === 'contradiction' ? 500 : 202 });
    },
  });
  try {
    for (const command of ['register', 'start']) {
      for (const value of [
        'rejected',
        'identity',
        'envelope',
        'invalid',
        'contradiction',
        'timeout',
      ]) {
        mode = value;
        const before = requests;
        const result = await run(
          `${server.url.origin}/api/v1`,
          command,
          command === 'register' ? submission() : { batchId: 'BATCH-001' },
          value === 'timeout' ? '50' : '5000',
        );
        expect(result.code).not.toBe(0);
        expect(result.value.error).toMatchObject({
          code: value === 'rejected' ? 'COMMAND_REJECTED' : 'OUTCOME_UNKNOWN',
          batchId: 'BATCH-001',
          stage: command,
        });
        if (value === 'rejected')
          expect(result.value.error.response.error.code).toBe('LOCAL_CONTROL_CONFLICT');
        if (value === 'timeout') expect(requests - before).toBeLessThanOrEqual(1);
        else expect(requests - before).toBe(1);
      }
    }
  } finally {
    server.stop(true);
  }
}, 30000);

test('Climber read responses require vendor evidence envelopes rather than subservice snapshots', async () => {
  let response: unknown = { workStatus: 'IDLE' };
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json(response);
    },
  });
  try {
    const base = `${server.url.origin}/api/v1`;
    expect((await run(base, 'health')).value.error.code).toBe('INVALID_RESPONSE');
    for (const task of [undefined, {}, { batchId: 'BATCH-001' }]) {
      response = { ok: true, data: { health: {}, task } };
      expect((await run(base, 'status')).value.error.code).toBe('INVALID_RESPONSE');
    }
    response = { ok: false, error: { code: 'DEVICE_OFFLINE', message: 'offline' } };
    expect((await run(base, 'status')).value.error.code).toBe('SERVICE_ERROR');
  } finally {
    server.stop(true);
  }
}, 30000);
