import { expect, test } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
  symlink,
  copyFile,
} from 'node:fs/promises';
import path from 'node:path';

const script = path.resolve(
  import.meta.dir,
  '..',
  '..',
  'skills',
  'device-automation',
  'scripts',
  'instrument.js',
);
const node = Bun.which('node');
if (!node || !path.isAbsolute(node))
  throw new Error('An absolute Node.js executable on PATH is required.');
const template = {
  name: 'Synthetic fixture template',
  deviceId: 'sim-analyzer-1',
  method: 'BET',
  gas: 'N2',
  temperatureK: 77,
  preprocessing: { temperatureC: 120, durationHours: 2 },
  sampleMassG: 0.1,
};

async function fixture(duration = '600000') {
  // Scratch data stays in the project and is removed by each test, never in system temp.
  const root = await mkdtemp(path.resolve(import.meta.dir, '..', '..', '.instrument-test-'));
  const data = path.join(root, 'simulation-data');
  const submission = {
    deviceId: template.deviceId,
    templateFile: 'fixture.json',
  };
  const statePath = path.join(data, 'simulation-state.json');
  async function run(
    command: string,
    args: unknown[] = [],
    env: Record<string, string> = {},
    executableScript = script,
  ) {
    const child = Bun.spawn(
      [
        node!,
        executableScript,
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
    const value = JSON.parse(stdout);
    expect(JSON.stringify(value)).not.toMatch(/"simulated"\s*:/);
    if (code !== 0) {
      expect(Object.keys(value)).toEqual(['error']);
      expect(Object.keys(value.error).sort()).toEqual(['code', 'message']);
    }
    return { code, value };
  }
  async function ok(command: string, args: unknown[] = [], env: Record<string, string> = {}) {
    const response = await run(command, args, env);
    expect(response.code).toBe(0);
    return response.value;
  }
  async function error(
    command: string,
    args: unknown[],
    code: string,
    env: Record<string, string> = {},
  ) {
    const response = await run(command, args, env);
    expect(response.code).not.toBe(0);
    expect(response.value.error.code).toBe(code);
    return response.value.error;
  }
  async function start(input = template) {
    const saved = { fileName: 'fixture.json' };
    const submission = { deviceId: input.deviceId, templateFile: saved.fileName };
    const { measurement } = await ok('submit-measurement', [submission]);
    return { saved, measurement, submission };
  }
  async function cleanArtifacts() {
    expect(
      (await readdir(data)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')),
    ).toEqual([]);
  }
  return {
    root,
    data,
    submission,
    statePath,
    run,
    ok,
    error,
    start,
    cleanArtifacts,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('persistent lifecycle, read-only completion, deterministic fixture results and idempotent report', async () => {
  const f = await fixture('1');
  try {
    const first = await f.ok('list');
    expect(first.devices.map((device: { id: string }) => device.id)).toEqual([
      'sim-analyzer-1',
      'sim-analyzer-2',
    ]);
    expect(
      first.devices.every(
        (device: { model: string; status: string }) =>
          device.model.includes('模拟分析仪') && device.status === 'idle',
      ),
    ).toBe(true);
    expect(await readdir(f.root)).toEqual([]);
    const removed = await f.error('validate-template', [template], 'INVALID_COMMAND');
    expect(removed.message).toContain('文档规定的命令');
    await f.error('list-templates', [], 'INVALID_COMMAND');
    await f.error('get-template', ['fixture.json'], 'INVALID_COMMAND');
    expect(await readdir(f.root)).toEqual([]);
    const { saved, measurement } = await f.start();
    expect(measurement.state).toBe('running');
    expect(measurement.progress).toBe(0);
    expect(measurement.templateSnapshot).toEqual(saved);
    const persisted = await readFile(f.statePath, 'utf8');
    const before = await stat(f.statePath);
    expect(JSON.parse(persisted).backend).toBe('simulation');
    expect(JSON.parse(persisted).schemaVersion).toBe(4);
    expect(JSON.parse(persisted).sourceProvenance.backend).toBe('simulation');
    expect((await f.ok('measurement', [measurement.id])).measurement).toMatchObject({
      state: 'completed',
      progress: 100,
    });
    expect((await f.ok('status', [template.deviceId])).device).toMatchObject({
      status: 'idle',
      activeMeasurementId: null,
    });
    await f.ok('list');
    const { result } = await f.ok('results', [measurement.id]);
    expect(result).toMatchObject({
      measurementId: measurement.id,
      templateFile: saved.fileName,
      templateSnapshot: saved,
      provenance: { backend: 'simulation', model: 'synthetic-adsorption-fixture-v1' },
      units: { surfaceArea: 'm2/g' },
    });
    expect(result.data).toHaveLength(7);
    expect((await f.ok('results', [measurement.id])).result).toEqual(result);
    for (const action of ['pause', 'resume', 'cancel'])
      await f.error('control-measurement', [measurement.id, action], 'INVALID_COMMAND');
    expect(await readFile(f.statePath, 'utf8')).toBe(persisted);
    expect((await stat(f.statePath)).mtimeMs).toBe(before.mtimeMs);
    const { report } = await f.ok('export-report', [measurement.id]);
    expect(path.dirname(report.path)).toBe(path.join(f.data, 'simulation-local-reports'));
    const contents = await readFile(report.path, 'utf8');
    const reportTime = (await stat(report.path)).mtimeMs;
    expect(JSON.parse(contents)).toMatchObject({
      schemaVersion: 1,
      backend: 'simulation',
      sourceProvenance: { backend: 'simulation' },
      report,
      result,
    });
    expect((await f.ok('export-report', [measurement.id])).report).toEqual(report);
    expect(await readFile(report.path, 'utf8')).toBe(contents);
    expect((await stat(report.path)).mtimeMs).toBe(reportTime);
    expect(JSON.parse(await readFile(f.statePath, 'utf8')).measurements[0].state).toBe('completed');
    const second = await f.start({
      ...template,
      name: 'Other fixture parameters',
      temperatureK: 99,
      sampleMassG: 5,
    });
    const other = (await f.ok('results', [second.measurement.id])).result;
    expect(other.data).toEqual(result.data);
    expect(other.summary).toEqual(result.summary);
    await writeFile(report.path, 'unknown report content');
    await f.error('export-report', [measurement.id], 'REPORT_CONFLICT');
    expect(await readFile(report.path, 'utf8')).toBe('unknown report content');
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
}, 20000);

test('legacy English provenance preserves persisted state, results and existing reports', async () => {
  const f = await fixture('1');
  try {
    const { saved, measurement } = await f.start();
    const state = JSON.parse(await readFile(f.statePath, 'utf8'));
    state.sourceProvenance.description =
      'Synthetic fixture data; not real measurements or scientific sample calculations.';
    await writeFile(f.statePath, JSON.stringify(state));
    const before = await readFile(f.statePath, 'utf8');
    const { result } = await f.ok('results', [measurement.id]);
    expect(result.provenance.description).toBe(state.sourceProvenance.description);
    expect(await readFile(f.statePath, 'utf8')).toBe(before);
    const { report } = await f.ok('export-report', [measurement.id]);
    const contents = await readFile(report.path, 'utf8');
    expect(JSON.parse(contents).sourceProvenance).toEqual(state.sourceProvenance);
    expect((await f.ok('export-report', [measurement.id])).report).toEqual(report);
    expect(await readFile(report.path, 'utf8')).toBe(contents);
  } finally {
    await f.cleanup();
  }
});

test('historical v1 tasks remain readable and exportable but cannot accept new submissions', async () => {
  const f = await fixture('1');
  try {
    const { saved, measurement } = await f.start();
    const state = JSON.parse(await readFile(f.statePath, 'utf8'));
    const parameters = template;
    const legacyTemplate = { id: 't-00000000-0000-4000-8000-000000000000', ...parameters };
    const { templateFile, ...task } = state.measurements[0];
    state.schemaVersion = 1;
    state.templates = [legacyTemplate];
    state.measurements = [
      {
        ...task,
        sampleId: 'historical-sample',
        templateId: legacyTemplate.id,
        templateSnapshot: legacyTemplate,
      },
    ];
    await writeFile(f.statePath, JSON.stringify(state));
    const before = await readFile(f.statePath, 'utf8');
    expect((await f.ok('results', [measurement.id])).result).toMatchObject({
      templateId: legacyTemplate.id,
      templateSnapshot: legacyTemplate,
    });
    await f.error('submit-measurement', [f.submission], 'LEGACY_STATE');
    expect(await readFile(f.statePath, 'utf8')).toBe(before);
    const { report } = await f.ok('export-report', [measurement.id]);
    const contents = await readFile(report.path, 'utf8');
    expect((await f.ok('export-report', [measurement.id])).report).toEqual(report);
    expect(await readFile(report.path, 'utf8')).toBe(contents);
    expect(JSON.parse(await readFile(f.statePath, 'utf8')).schemaVersion).toBe(1);
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
});

test('historical v2 task snapshots remain readable without a template directory', async () => {
  const f = await fixture('1');
  try {
    const { measurement } = await f.start();
    const state = JSON.parse(await readFile(f.statePath, 'utf8'));
    state.schemaVersion = 2;
    state.measurements[0].sampleId = 'historical-sample';
    state.measurements[0].templateSnapshot = { fileName: 'fixture.json', ...template };
    await writeFile(f.statePath, JSON.stringify(state));
    const before = await readFile(f.statePath, 'utf8');
    const { result } = await f.ok('results', [measurement.id]);
    expect(result.templateSnapshot).toEqual(state.measurements[0].templateSnapshot);
    expect(result.method).toBe('BET');
    await f.error('submit-measurement', [f.submission], 'LEGACY_STATE');
    expect(await readFile(f.statePath, 'utf8')).toBe(before);
    const { report } = await f.ok('export-report', [measurement.id]);
    expect(JSON.parse(await readFile(report.path, 'utf8')).result).toEqual(result);
    expect(JSON.parse(await readFile(f.statePath, 'utf8')).schemaVersion).toBe(2);
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
});

test('running tasks reject controls without writes and retain busy/readiness behavior', async () => {
  const f = await fixture();
  try {
    const { measurement, submission } = await f.start();
    await f.error('submit-measurement', [submission], 'DEVICE_BUSY');
    await f.error('results', [measurement.id], 'RESULTS_NOT_READY');
    await f.error('export-report', [measurement.id], 'RESULTS_NOT_READY');
    const persisted = await readFile(f.statePath, 'utf8');
    for (const action of ['pause', 'resume', 'cancel'])
      await f.error('control-measurement', [measurement.id, action], 'INVALID_COMMAND');
    await f.error('save-template', [template], 'INVALID_COMMAND');
    expect(await readFile(f.statePath, 'utf8')).toBe(persisted);
    expect((await f.ok('status', [template.deviceId])).device).toMatchObject({
      status: 'busy',
      activeMeasurementId: measurement.id,
    });
    expect((await f.ok('measurement', [measurement.id])).measurement.state).toBe('running');
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
});

test('submissions accept sourced filenames without querying or reading a template directory', async () => {
  const f = await fixture('1');
  try {
    for (const command of [
      'reset',
      'real-endpoint',
      '',
      'list extra',
      'save-template',
      'validate-template',
      'control-measurement',
      'list-templates',
      'get-template',
    ])
      await f.error(command, [], 'INVALID_COMMAND');
    await f.error('get-template', ['fixture.json'], 'INVALID_COMMAND');
    await f.error('list', ['extra'], 'INVALID_COMMAND');
    await f.error('status', [''], 'NOT_FOUND');
    for (const command of ['measurement', 'results', 'export-report'])
      await f.error(command, ['../unsafe'], 'INVALID_IDENTIFIER');
    for (const fileName of [
      '',
      '.',
      '..',
      '../fixture.json',
      '..\\fixture.json',
      '/fixture.json',
      'C:\\fixture.json',
      'CON.json',
      'nul',
      'x:fixture.json',
      'x*.json',
      ' fixture.json',
      'fixture.',
      'fixture ',
      'x'.repeat(129),
    ])
      await f.error(
        'submit-measurement',
        [{ ...f.submission, templateFile: fileName }],
        'INVALID_SUBMISSION',
      );
    for (const invalid of [
      null,
      [],
      {},
      { ...f.submission, extra: true },
      { ...f.submission, sampleId: 'unsupported' },
      { ...f.submission, templateFile: template },
      { ...f.submission, deviceId: 'real-instrument' },
      { deviceId: template.deviceId, templateId: 'legacy', sampleId: 'fixture' },
    ])
      await f.error('submit-measurement', [invalid], 'INVALID_SUBMISSION');
    const malformed = await f.error(
      'submit-measurement',
      ['{"secret":"do-not-echo"'],
      'INVALID_JSON',
    );
    expect(malformed.message).not.toContain('do-not-echo');
    await f.error('submit-measurement', ['x'.repeat(17000)], 'PAYLOAD_TOO_LARGE');
    expect(await readdir(f.root)).toEqual([]);
    for (const fileName of ['fixture.json', '已有设备模板.xml', 'BET-template', 'method.tpl']) {
      const { measurement } = await f.ok('submit-measurement', [
        { ...f.submission, templateFile: fileName },
      ]);
      expect(measurement.templateFile).toBe(fileName);
      expect(measurement.templateSnapshot).toEqual({ fileName });
      expect((await f.ok('results', [measurement.id])).result).not.toHaveProperty('method');
    }
    expect(await readdir(f.root)).toEqual(['simulation-data']);
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
}, 15000);

test('malformed state fails closed and unknown files and existing locks remain untouched', async () => {
  const f = await fixture();
  try {
    const { measurement } = await f.start();
    const original = await readFile(f.statePath, 'utf8');
    const corruptions = [
      '{invalid',
      '{}',
      JSON.stringify({ ...JSON.parse(original), schemaVersion: 99 }),
      JSON.stringify({ ...JSON.parse(original), backend: 'real' }),
      (() => {
        const state = JSON.parse(original);
        state.measurements[0].templateSnapshot.fileName = 'other.json';
        return JSON.stringify(state);
      })(),
      (() => {
        const state = JSON.parse(original);
        state.measurements.push({
          ...state.measurements[0],
          id: 'm-00000000-0000-4000-8000-000000000000',
        });
        return JSON.stringify(state);
      })(),
    ];
    for (const content of corruptions) {
      await writeFile(f.statePath, content);
      await f.error('list', [], 'CORRUPT_STATE');
      await f.error('submit-measurement', [f.submission], 'CORRUPT_STATE');
      expect(await readFile(f.statePath, 'utf8')).toBe(content);
      await f.cleanArtifacts();
    }
    await writeFile(f.statePath, 'x'.repeat(2 * 1024 * 1024 + 1));
    await f.error('list', [], 'STATE_TOO_LARGE');
    await f.error('submit-measurement', [f.submission], 'STATE_TOO_LARGE');
    await writeFile(f.statePath, original);
    const unknown = path.join(f.data, 'unknown.txt');
    await writeFile(unknown, 'do not touch');
    const lock = path.join(f.data, 'simulation-state.lock');
    await writeFile(lock, 'external lock, deliberately stale');
    await f.error('submit-measurement', [f.submission], 'STATE_LOCKED');
    await f.error('export-report', [measurement.id], 'STATE_LOCKED');
    await f.ok('list');
    expect(await readFile(lock, 'utf8')).toBe('external lock, deliberately stale');
    expect(await readFile(f.statePath, 'utf8')).toBe(original);
    expect(await readFile(unknown, 'utf8')).toBe('do not touch');
    await rm(lock);
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
}, 15000);

test('failed atomic saves and report publication remove only their own locks and temporary files', async () => {
  const f = await fixture('1');
  try {
    const { measurement } = await f.start();
    const original = await readFile(f.statePath, 'utf8');
    const unknown = path.join(f.data, '.simulation-write-unknown.tmp');
    await writeFile(unknown, 'unknown file');
    const preload = path.join(f.root, 'deny-publication.cjs');
    await writeFile(
      preload,
      "const fs = require('node:fs'); fs.renameSync = fs.linkSync = () => { throw new Error('Injected publication failure'); };\n",
    );
    const env = { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
    await f.error('submit-measurement', [f.submission], 'IO_ERROR', env);
    expect(await readFile(f.statePath, 'utf8')).toBe(original);
    await f.error('export-report', [measurement.id], 'IO_ERROR', env);
    expect(await readFile(f.statePath, 'utf8')).toBe(original);
    expect(await readdir(path.join(f.data, 'simulation-local-reports'))).toEqual([]);
    expect(
      (await readdir(f.data)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')),
    ).toEqual([path.basename(unknown)]);
    expect(await readFile(unknown, 'utf8')).toBe('unknown file');
  } finally {
    await f.cleanup();
  }
});

test('parallel filename submissions allow only one active task per device', async () => {
  const f = await fixture();
  try {
    const starts = await Promise.all(
      Array.from({ length: 6 }, () => f.run('submit-measurement', [f.submission])),
    );
    expect(starts.filter((response) => response.code === 0)).toHaveLength(1);
    expect(
      starts
        .filter((response) => response.code !== 0)
        .every((response) => ['STATE_LOCKED', 'DEVICE_BUSY'].includes(response.value.error.code)),
    ).toBe(true);
    expect(JSON.parse(await readFile(f.statePath, 'utf8')).measurements).toHaveLength(1);
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
}, 10000);

test('path safety rejects directory junctions, symlink report entries and nonregular state entries', async () => {
  const f = await fixture('1');
  try {
    const target = path.join(f.root, 'untouched');
    await mkdir(target);
    await writeFile(path.join(target, 'sentinel'), 'untouched');
    await symlink(target, f.data, 'junction');
    await f.error('list', [], 'UNSAFE_PATH');
    await f.error('submit-measurement', [f.submission], 'UNSAFE_PATH');
    expect(await readdir(target)).toEqual(['sentinel']);
    await rm(f.data);
    const { measurement } = await f.start();
    const reportDir = path.join(f.data, 'simulation-local-reports');
    await symlink(target, reportDir, 'junction');
    await f.error('export-report', [measurement.id], 'UNSAFE_PATH');
    expect(await readdir(target)).toEqual(['sentinel']);
    await rm(reportDir);
    await mkdir(reportDir);
    const reportPath = path.join(reportDir, `r-${measurement.id}.json`);
    await symlink(target, reportPath, 'junction');
    await f.error('export-report', [measurement.id], 'UNSAFE_PATH');
    expect(await readdir(target)).toEqual(['sentinel']);
    await rm(f.statePath);
    await symlink(target, f.statePath, 'junction');
    await f.error('list', [], 'UNSAFE_PATH');
    await f.error('submit-measurement', [f.submission], 'UNSAFE_PATH');
    expect(await readdir(target)).toEqual(['sentinel']);
    await rm(f.statePath);
    await mkdir(f.statePath);
    await f.error('list', [], 'UNSAFE_PATH');
    await f.error('submit-measurement', [f.submission], 'UNSAFE_PATH');
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
}, 10000);

test('configuration is bounded, standalone CommonJS is supported, and networking modules are never loaded', async () => {
  const f = await fixture();
  try {
    await f.error('list', [], 'INVALID_CONFIGURATION', { AUTO_AGENT_SIMULATION_DIR: 'relative' });
    await f.error('list', [], 'INVALID_CONFIGURATION', { AUTO_AGENT_SIMULATION_DIR: '' });
    await f.error('list', [], 'INVALID_CONFIGURATION', {
      AUTO_AGENT_SIMULATION_DIR: path.dirname(script),
    });
    for (const duration of ['', '0', '-1', '1.5', '600001', 'Infinity', '1e3'])
      await f.error('list', [], 'INVALID_CONFIGURATION', {
        AUTO_AGENT_SIMULATION_DURATION_MS: duration,
      });
    const bundle = path.join(f.root, 'bundle', 'scripts');
    await mkdir(bundle, { recursive: true });
    const standalone = path.join(bundle, 'instrument.cjs');
    await copyFile(script, standalone);
    const preload = path.join(f.root, 'deny-network.cjs');
    await writeFile(
      preload,
      "const Module = require('node:module'); const load = Module._load; Module._load = function(id, ...args) { if (/^(node:)?(http|https|http2|net|tls|dgram)$/.test(id)) throw new Error('Network access forbidden'); return load.call(this, id, ...args); };\n",
    );
    const env = { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` };
    const listed = await f.run('list', [], env, standalone);
    expect(listed.code).toBe(0);
    const started = await f.run(
      'submit-measurement',
      [
        {
          deviceId: template.deviceId,
          templateFile: 'fixture.json',
        },
      ],
      { ...env, AUTO_AGENT_SIMULATION_DURATION_MS: '1' },
      standalone,
    );
    expect(started.code).toBe(0);
    expect((await f.run('results', [started.value.measurement.id], env, standalone)).code).toBe(0);
    expect(
      (await f.run('export-report', [started.value.measurement.id], env, standalone)).code,
    ).toBe(0);
    const source = await readFile(script, 'utf8');
    expect(source).not.toMatch(/require\(['"](?:node:)?(?:http|https|http2|net|tls|dgram)['"]\)/);
    await f.cleanArtifacts();
  } finally {
    await f.cleanup();
  }
}, 10000);
