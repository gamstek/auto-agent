import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import path from 'node:path';

const script = path.resolve('skills/device-automation/scripts/automation.js');
const node = Bun.which('node');
if (!node) throw new Error('Node.js is required for skill script tests.');

async function fixture(duration = '600000') {
  const root = await mkdtemp(path.resolve('.automation-test-'));
  const data = path.join(root, 'simulation-data');
  const statePath = path.join(data, 'simulation-state.json');
  const submission = { deviceId: 'sim-automation-1', templateFile: 'existing-workflow.tpl' };
  async function run(command: string, args: unknown[] = [], env: Record<string, string> = {}) {
    const child = Bun.spawn(
      [
        node!,
        script,
        command,
        ...args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          AUTO_AGENT_SIMULATION_DIR: data,
          AUTO_AGENT_SIMULATION_DURATION_MS: duration,
          ...env,
        },
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
    expect(stdout.trim().split('\n')).toHaveLength(1);
    return { code, value: JSON.parse(stdout) };
  }
  async function ok(command: string, args: unknown[] = []) {
    const result = await run(command, args);
    expect(result.code).toBe(0);
    expect(result.value.backend).toBe('simulation');
    return result.value;
  }
  async function error(
    command: string,
    args: unknown[],
    code: string,
    env: Record<string, string> = {},
  ) {
    const result = await run(command, args, env);
    expect(result.code).not.toBe(0);
    expect(result.value.error.code).toBe(code);
  }
  const start = async () => (await ok('submit-run', [submission])).run;
  const cleanArtifacts = async () =>
    expect(
      (await readdir(data)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')),
    ).toEqual([]);
  return {
    root,
    data,
    statePath,
    submission,
    run,
    ok,
    error,
    start,
    cleanArtifacts,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('automation workflow persists a run, projects completion without writes and publishes a source-labelled report', async () => {
  const f = await fixture('1');
  try {
    const list = await f.ok('list');
    expect(
      list.devices.map((device: { id: string; kind: string }) => [device.id, device.kind]),
    ).toEqual([
      ['sim-automation-1', 'preset-workflow'],
      ['sim-automation-2', 'preset-workflow'],
    ]);
    expect(await readdir(f.root)).toEqual([]);
    const run = await f.start();
    expect(run).toMatchObject({ ...f.submission, state: 'running', progress: 0 });
    const persisted = await readFile(f.statePath, 'utf8');
    const before = await stat(f.statePath);
    expect(JSON.parse(persisted)).toMatchObject({
      schemaVersion: 1,
      kind: 'preset-workflow',
      backend: 'simulation',
    });
    expect((await f.ok('run', [run.id])).run).toMatchObject({ state: 'completed', progress: 100 });
    expect((await f.ok('status', [f.submission.deviceId])).device).toMatchObject({
      status: 'idle',
      activeRunId: null,
    });
    const { result } = await f.ok('results', [run.id]);
    expect(result).toMatchObject({
      runId: run.id,
      ...f.submission,
      provenance: { backend: 'simulation' },
      units: { surfaceArea: 'm2/g' },
    });
    expect(result.data).toHaveLength(7);
    expect(result).not.toHaveProperty('method');
    expect(await readFile(f.statePath, 'utf8')).toBe(persisted);
    expect((await stat(f.statePath)).mtimeMs).toBe(before.mtimeMs);
    const { report } = await f.ok('export-report', [run.id]);
    expect(report.runId).toBe(run.id);
    expect(path.dirname(report.path)).toBe(path.join(f.data, 'simulation-local-reports'));
    const content = await readFile(report.path, 'utf8');
    expect(JSON.parse(content)).toMatchObject({ backend: 'simulation', report, result });
    const reportTime = (await stat(report.path)).mtimeMs;
    expect((await f.ok('export-report', [run.id])).report).toEqual(report);
    expect((await stat(report.path)).mtimeMs).toBe(reportTime);
    const other = await f.start();
    expect((await f.ok('results', [other.id])).result.summary).toEqual(result.summary);
    await writeFile(report.path, 'unrelated content');
    await f.error('export-report', [run.id], 'REPORT_CONFLICT');
    expect(await readFile(report.path, 'utf8')).toBe('unrelated content');
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
});

test('active automation run owns device capacity and gates results and reports', async () => {
  const f = await fixture();
  try {
    const run = await f.start();
    const original = await readFile(f.statePath, 'utf8');
    await f.error('submit-run', [f.submission], 'DEVICE_BUSY');
    await f.error('results', [run.id], 'RESULTS_NOT_READY');
    await f.error('export-report', [run.id], 'RESULTS_NOT_READY');
    expect((await f.ok('status', [f.submission.deviceId])).device).toMatchObject({
      status: 'busy',
      activeRunId: run.id,
    });
    expect((await f.ok('run', [run.id])).run.state).toBe('running');
    expect(await readFile(f.statePath, 'utf8')).toBe(original);
    const second = await f.ok('submit-run', [{ ...f.submission, deviceId: 'sim-automation-2' }]);
    expect(second.run.deviceId).toBe('sim-automation-2');
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
});

test('workflow submission enforces sourced filenames, exact fields and documented operations', async () => {
  const f = await fixture('1');
  try {
    for (const command of [
      'pause',
      'cancel',
      'reset',
      'submit-measurement',
      'measurement',
      'list-templates',
    ])
      await f.error(command, [], 'INVALID_COMMAND');
    await f.error('list', ['extra'], 'INVALID_COMMAND');
    await f.error('status', [''], 'NOT_FOUND');
    for (const command of ['run', 'results', 'export-report'])
      await f.error(command, ['../unsafe'], 'INVALID_IDENTIFIER');
    for (const templateFile of [
      '',
      '.',
      '..',
      '../a.tpl',
      '..\\a.tpl',
      'C:\\a.tpl',
      'CON.tpl',
      'a*.tpl',
      ' a.tpl',
      'a.',
      'a ',
      'x'.repeat(129),
    ])
      await f.error('submit-run', [{ ...f.submission, templateFile }], 'INVALID_SUBMISSION');
    for (const input of [
      null,
      [],
      {},
      { ...f.submission, extra: true },
      { ...f.submission, sampleName: 'A' },
      { ...f.submission, deviceId: 'climber' },
    ])
      await f.error('submit-run', [input], 'INVALID_SUBMISSION');
    await f.error('submit-run', ['{invalid'], 'INVALID_JSON');
    await f.error('submit-run', ['x'.repeat(17000)], 'PAYLOAD_TOO_LARGE');
    expect(await readdir(f.root)).toEqual([]);
    for (const templateFile of ['existing.tpl', '已有流程.xml', 'BET-workflow']) {
      const { run } = await f.ok('submit-run', [{ ...f.submission, templateFile }]);
      expect(run.templateFile).toBe(templateFile);
      expect((await f.ok('results', [run.id])).result.templateFile).toBe(templateFile);
    }
  } finally {
    await f.cleanup();
  }
}, 15000);

test('only current workflow state is accepted; invalid data is never migrated or overwritten', async () => {
  const f = await fixture();
  try {
    await f.start();
    const original = JSON.parse(await readFile(f.statePath, 'utf8'));
    const invalid = [
      '{invalid',
      '{}',
      JSON.stringify({ ...original, schemaVersion: 4 }),
      JSON.stringify({ ...original, backend: 'real' }),
      JSON.stringify({ ...original, measurements: [] }),
      JSON.stringify({
        ...original,
        sourceProvenance: { ...original.sourceProvenance, description: 'old provenance' },
      }),
      JSON.stringify({ ...original, runs: [{ ...original.runs[0], templateSnapshot: {} }] }),
      JSON.stringify({ ...original, runs: [{ ...original.runs[0], state: 'paused' }] }),
      JSON.stringify({
        ...original,
        runs: [
          ...original.runs,
          { ...original.runs[0], id: 'run-00000000-0000-4000-8000-000000000000' },
        ],
      }),
    ];
    for (const content of invalid) {
      await writeFile(f.statePath, content);
      await f.error('list', [], 'CORRUPT_STATE');
      await f.error('submit-run', [f.submission], 'CORRUPT_STATE');
      expect(await readFile(f.statePath, 'utf8')).toBe(content);
      await f.cleanArtifacts();
    }
    await writeFile(f.statePath, 'x'.repeat(2 * 1024 * 1024 + 1));
    await f.error('list', [], 'STATE_TOO_LARGE');
  } finally {
    await f.cleanup();
  }
});

test('concurrent starts permit one active workflow and preserve existing locks', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => f.run('submit-run', [f.submission])),
    );
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(
      results
        .filter((result) => result.code !== 0)
        .every((result) => ['STATE_LOCKED', 'DEVICE_BUSY'].includes(result.value.error.code)),
    ).toBe(true);
    const content = await readFile(f.statePath, 'utf8');
    const lock = path.join(f.data, 'simulation-state.lock');
    await writeFile(lock, 'external lock');
    await f.error('submit-run', [f.submission], 'STATE_LOCKED');
    await f.ok('list');
    expect(await readFile(lock, 'utf8')).toBe('external lock');
    expect(await readFile(f.statePath, 'utf8')).toBe(content);
    await rm(lock);
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
});

test('failed publication removes owned temporary files and leaves prior state and unrelated files intact', async () => {
  const f = await fixture('1');
  try {
    const run = await f.start();
    const original = await readFile(f.statePath, 'utf8');
    const sentinel = path.join(f.data, 'unrelated.txt');
    await writeFile(sentinel, 'keep');
    const preload = path.join(f.root, 'deny-publication.cjs');
    await writeFile(
      preload,
      "const fs = require('node:fs'); fs.renameSync = fs.linkSync = () => { throw new Error('publication failure'); };\n",
    );
    const env = { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
    await f.error('submit-run', [f.submission], 'IO_ERROR', env);
    await f.error('export-report', [run.id], 'IO_ERROR', env);
    expect(await readFile(f.statePath, 'utf8')).toBe(original);
    expect(await readFile(sentinel, 'utf8')).toBe('keep');
    expect(await readdir(path.join(f.data, 'simulation-local-reports'))).toEqual([]);
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
});

test('simulation configuration and filesystem boundaries are enforced', async () => {
  const f = await fixture('1');
  try {
    for (const directory of ['', 'relative', path.dirname(script)])
      await f.error('list', [], 'INVALID_CONFIGURATION', { AUTO_AGENT_SIMULATION_DIR: directory });
    for (const duration of ['', '0', '-1', '1.5', '600001', 'Infinity'])
      await f.error('list', [], 'INVALID_CONFIGURATION', {
        AUTO_AGENT_SIMULATION_DURATION_MS: duration,
      });
    const target = path.join(f.root, 'untouched');
    await mkdir(target);
    await writeFile(path.join(target, 'sentinel'), 'keep');
    await symlink(target, f.data, 'junction');
    await f.error('list', [], 'UNSAFE_PATH');
    await f.error('submit-run', [f.submission], 'UNSAFE_PATH');
    await rm(f.data);
    const run = await f.start();
    const reports = path.join(f.data, 'simulation-local-reports');
    await symlink(target, reports, 'junction');
    await f.error('export-report', [run.id], 'UNSAFE_PATH');
    await rm(reports);
    await mkdir(reports);
    await symlink(target, path.join(reports, `r-${run.id}.json`), 'junction');
    await f.error('export-report', [run.id], 'UNSAFE_PATH');
    await rm(f.statePath);
    await symlink(target, f.statePath, 'junction');
    await f.error('list', [], 'UNSAFE_PATH');
    await rm(f.statePath);
    await mkdir(f.statePath);
    await f.error('submit-run', [f.submission], 'UNSAFE_PATH');
    expect(await readdir(target)).toEqual(['sentinel']);
    expect(await readFile(path.join(target, 'sentinel'), 'utf8')).toBe('keep');
  } finally {
    await f.cleanup();
  }
});
