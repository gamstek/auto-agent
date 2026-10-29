import { expect, test } from 'bun:test';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from '../helpers';

const script = resolve('skills/device-automation/scripts/sam.js');
const node = Bun.which('node');
if (!node) throw new Error('Node.js is required for SAM script tests.');
function sample() {
  return {
    'sample name': '合成样品😀',
    softwareVersion: 'fixture',
    clientVersion: 'fixture-current',
    unit: 2,
    port: 0,
    analysisStatus: 0x1010,
    mass: { 'sample mass': 1.5, 'tube mass': 29.1 },
    'analysis conditions': {
      'analysis type': 0,
      'adsorptive properties': { 'gas type': 2, mnemonic: 'N2', 'maximum manifold pressure': 1000 },
      'p0 and temperature options': { p0: 760, temperature: -195.85 },
      'free space options': { 'free space option type': 0 },
      'isotherm collection': {
        'use target pressure': true,
        'absolute pressure dosing': false,
        pressures: [
          { start_p: 0.05, end_p: 0.3, increment_p: 0.025, interval: 5 },
          { start_p: 0.3, end_p: 0.1, increment_p: 0, interval: 10 },
        ],
        increments: [
          {
            end_p: 0.1,
            'use dose increment': true,
            'dose increment': 10,
            'percent of previous': 20,
            interval: 30,
          },
        ],
        options: {
          'absolute pressure tolerance': 5,
          T_LPressIncrementalDoseMode: true,
          T_DoseAmount: 15,
          T_MinEquilibrationDelay: 0.5,
          T_MaxEquilibrationDelay: 2,
          D_LPressIncrementalDoseMode: true,
          D_DoseAmount: 20,
          D_MinEquilibrationDelay: 0,
          D_MaxEquilibrationDelay: 3,
        },
      },
    },
    reports: [{ type: 1, options: { name: 'BET', selected: false } }],
  };
}
function encode(value: unknown, status = 0x1010) {
  const body = Buffer.from(JSON.stringify(value), 'utf16le').swap16();
  const header = Buffer.alloc(8);
  header.writeInt32BE(status, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
function newTemplate() {
  const root = sample();
  return {
    ...root,
    'sample tube': { name: 'fixture tube', 'use isothermal jacket': true },
    'analysis conditions': {
      ...root['analysis conditions'],
      'preparation options': { 'fast evacuation': false, 'evacuation time': 1 },
      'sample backfill options': { 'backfill sample at end of analysis': true, 'backfill gas': 2 },
    },
    extension: { retained: [false, 0, null, '未知字段'] },
  };
}
function decode(bytes: Buffer) {
  expect(bytes.readUInt32BE(4)).toBe(bytes.length - 8);
  return JSON.parse(new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(8)));
}
async function setup() {
  const f = await fixture();
  const path = join(f.dir, '样品 configuration.SAM');
  async function run(
    command = 'inspect',
    extra: Record<string, unknown> = {},
    runtime: string | string[] = node!,
  ) {
    const process = Bun.spawn(
      [
        ...(Array.isArray(runtime) ? runtime : [runtime]),
        script,
        command,
        JSON.stringify({ ...(command === 'profiles' ? {} : { path }), product: 'g5', ...extra }),
      ],
      {
        cwd: f.dir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          SystemRoot: globalThis.process.env.SystemRoot,
          SAM_OUTPUT_DIR: join(f.dir, 'generated'),
        },
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(stderr).toBe('');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    return { code, value: JSON.parse(stdout) };
  }
  return { ...f, path, run };
}

test('SAM inspection preserves framing, identity, provenance and ordered configuration without writing', async () => {
  const f = await setup();
  try {
    const source = encode(sample());
    await writeFile(f.path, source);
    const before = await stat(f.path);
    const runtimes: (string | string[])[] = [node!, process.execPath];
    if (process.env.AUTO_AGENT_TEST_BINARY)
      runtimes.push([
        resolve(
          process.env.AUTO_AGENT_TEST_BINARY_PATH ??
            join('dist', process.platform === 'win32' ? 'auto-agent.exe' : 'auto-agent'),
        ),
        '--auto-agent-internal-script',
      ]);
    for (const runtime of runtimes) {
      const result = await f.run('inspect', {}, runtime);
      expect(result.code).toBe(0);
      const value = result.value;
      expect(value.file).toMatchObject({ bytes: source.length, format: 'qt-utf16be-json' });
      expect(value.file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(value.status).toMatchObject({ raw: 0x1010, family: 'g5', state: 'new' });
      expect(value.identity).toEqual({ sampleName: '合成样品😀', uuid: null, unit: 2, port: 0 });
      expect(value.facts.analysisType.value).toBe('bet');
      expect(value.facts.sampleMassG).toMatchObject({
        value: 1.5,
        unit: 'g',
        source: ['mass', 'sample mass'],
      });
      expect(value.pressureProgram.segments.map((row: any) => row.direction)).toEqual([
        'ascending',
        'descending',
      ]);
      expect(value.pressureProgram.segments[1].endpointOnly).toBe(true);
      expect(value.incrementProgram.active).toBe(false);
      expect(value.reports[0].selected).toBe(false);
      expect(value.executionVerified).toBe(false);
      expect(value.interpretation.versionVerified).toBe(false);
    }
    expect(await readFile(f.path)).toEqual(source);
    expect((await stat(f.path)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await f.cleanup();
  }
});

test('absolute pressure scaling is limited to segment pressures and T/D units remain distinct', async () => {
  const f = await setup();
  try {
    const root = sample();
    const collection = root['analysis conditions']['isotherm collection'];
    collection['absolute pressure dosing'] = true;
    collection['use target pressure'] = false;
    collection.pressures = [{ start_p: 0, end_p: 0.76, increment_p: 0.02, interval: 30 }];
    await writeFile(f.path, encode(root));
    const { value } = await f.run();
    expect(value.pressureProgram.segments[0]).toMatchObject({
      start: 0,
      end: 760,
      step: 20,
      intervalSeconds: 30,
    });
    expect(value.incrementProgram.segments[0].end).toBe(100);
    expect(value.facts.p0MmHg.value).toBe(760);
    expect(value.facts.maximumManifoldPressureMmHg.value).toBe(1000);
    expect(value.facts.absolutePressureToleranceMmHg.value).toBe(5);
    expect(value.facts.lowPressureDoseCm3StpPerG.value).toBe(20);
    expect(value.facts.lowPressureMinHours).toMatchObject({ value: 0, unit: 'h' });
    expect(value.facts.lowPressureMaxHours.value).toBe(3);
    expect(value.facts.temperatureK.value).toBeCloseTo(77.3);
  } finally {
    await f.cleanup();
  }
});

test('comparisons distinguish requested tolerances, inactive tables, unsupported enums and missing fields', async () => {
  const f = await setup();
  try {
    const root = sample();
    await writeFile(f.path, encode(root));
    let result = await f.run('compare', {
      requirements: {
        gasMnemonic: 'N2',
        temperatureK: 77.3,
        lowPressureMinHours: 0.5,
        pressureMode: 'relative-pp0',
        pressureProgram: [
          { start: 0.05, end: 0.3, step: 0.025, intervalSeconds: 5 },
          { start: 0.3, end: 0.1, step: 0, intervalSeconds: 10 },
        ],
      },
    });
    expect(result.value.comparison.overall).toBe('match');
    expect(result.value.executionVerified).toBe(false);
    result = await f.run('compare', { requirements: { temperatureK: 77 } });
    expect(result.value.comparison.overall).toBe('mismatch');
    result = await f.run('compare', {
      requirements: { temperatureK: 77 },
      tolerances: { temperatureK: 0.5 },
    });
    expect(result.value.comparison.overall).toBe('match');
    result = await f.run('compare', { requirements: { freeSpaceMode: 'post-calibration' } });
    expect(result.value.comparison.checks[0].status).toBe('unsupported');
    root['analysis conditions']['isotherm collection']['use target pressure'] = false;
    root['analysis conditions']['isotherm collection'].options.D_LPressIncrementalDoseMode = false;
    await writeFile(f.path, encode(root));
    result = await f.run('compare', {
      requirements: {
        pressureMode: 'relative-pp0',
        pressureProgram: [],
        lowPressureDoseCm3StpPerG: 20,
      },
    });
    expect(result.value.comparison.overall).toBe('unknown');
    expect(result.value.facts.lowPressureDoseCm3StpPerG.value).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('G12 mapping, completed-state warnings and ambiguous product selection remain explicit', async () => {
  const f = await setup();
  try {
    const root = sample();
    root.analysisStatus = 0x2040;
    root['analysis conditions']['analysis type'] = 10;
    root['analysis conditions']['free space options']['free space option type'] = 1;
    await writeFile(
      f.path,
      encode({ ...root, completed: '2026/10/27 10:00:00', 'analysis data': [1] }, 0x2040),
    );
    const { value } = await f.run('inspect', { product: 'g12' });
    expect(value.facts.analysisType.value).toBe('micropore');
    expect(value.facts.freeSpaceMode.value).toBe('post-calibration');
    expect(value.warnings.map((w: any) => w.code)).toContain('HISTORICAL_DATA');
    expect(value.status.state).toBe('completed');
    const mismatched = await f.run('compare', {
      product: 'g5',
      requirements: { analysisType: 'micropore' },
    });
    expect(mismatched.value.comparison.overall).toBe('unknown');
    expect(mismatched.value.warnings.map((w: any) => w.code)).toContain('PRODUCT_STATUS_MISMATCH');
    const unverified = await f.run('inspect', { product: 's60pro' });
    expect(unverified.value.facts.analysisType.value).toBeNull();
    expect(unverified.value.facts.freeSpaceMode.value).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('malformed framing and foreign SMP fail rather than being treated as supported templates', async () => {
  const f = await setup();
  try {
    const valid = encode(sample());
    const nullString = Buffer.alloc(8);
    nullString.writeUInt32BE(0xffffffff, 4);
    const badUtf16 = Buffer.alloc(10);
    badUtf16.writeUInt32BE(2, 4);
    badUtf16[8] = 0xd8;
    for (const [buffer, code] of [
      [Buffer.alloc(4), 'INVALID_HEADER'],
      [nullString, 'EMPTY_TEMPLATE'],
      [valid.subarray(0, valid.length - 1), 'INVALID_HEADER'],
      [Buffer.concat([valid, Buffer.alloc(2)]), 'INVALID_HEADER'],
      [badUtf16, 'INVALID_ENCODING'],
      [encode([]), 'INVALID_JSON'],
      [encode({ reports: [] }), 'NOT_SAMPLE_TEMPLATE'],
      [Buffer.from('^vMIC##&&FS\x000200'), 'UNSUPPORTED_FORMAT'],
    ] as const) {
      await writeFile(f.path, buffer);
      const result = await f.run();
      expect(result.code).not.toBe(0);
      expect(result.value.error.code).toBe(code);
    }
    await writeFile(f.path, JSON.stringify(sample()));
    expect((await f.run()).value.file.format).toBe('utf8-json');
  } finally {
    await f.cleanup();
  }
});

test('unknown scalar types and null tables are not coerced into valid configuration', async () => {
  const f = await setup();
  try {
    const root = sample();
    await writeFile(
      f.path,
      encode({
        ...root,
        'analysis conditions': {
          ...root['analysis conditions'],
          'analysis type': '0',
          'isotherm collection': { pressures: null, increments: null },
        },
      }),
    );
    const { value } = await f.run();
    expect(value.facts.analysisType.value).toBeNull();
    expect(value.facts.analysisType.rawValue).toBe('0');
    expect(value.facts.pressureMode.value).toBeNull();
    expect(value.facts.pressureMode.presence).toBe('missing');
    expect(value.pressureProgram.presence).toBe('null');
    expect(value.pressureProgram.segments).toBeNull();
    expect(value.incrementProgram.segments).toBeNull();
    for (const requirements of [
      { typo: true },
      { temperatureK: -1 },
      { pressureProgram: [] },
      { lowPressureEnabled: 1 },
    ]) {
      const result = await f.run('compare', { requirements });
      expect(result.value.error.code).toBe('INVALID_INPUT');
    }
    const result = await f.run('compare', {
      requirements: { temperatureK: 77 },
      tolerances: { gasMnemonic: 1 },
    });
    expect(result.value.error.code).toBe('INVALID_INPUT');
    root['analysis conditions']['isotherm collection'].pressures = Array.from(
      { length: 257 },
      () => ({ start_p: 0, end_p: 0.1, increment_p: 0, interval: 5 }),
    );
    await writeFile(f.path, encode(root));
    expect((await f.run()).value.error.code).toBe('INVALID_SEGMENTS');
  } finally {
    await f.cleanup();
  }
});

test('create produces independent G5/G12 templates with correct Qt framing and no overwrite', async () => {
  const f = await setup();
  try {
    for (const product of ['g5', 'g12']) {
      const target = join(f.dir, `${product}.SAM`);
      const template = newTemplate();
      const result = await f.run('create', { path: target, product, template });
      expect(result.code).toBe(0);
      expect(result.value).toMatchObject({
        operation: 'create',
        written: true,
        executionVerified: false,
      });
      const bytes = await readFile(target);
      const root = decode(bytes);
      expect(bytes.readInt32BE(0)).toBe(product === 'g5' ? 0x1010 : 0x2010);
      expect(root.analysisStatus).toBe(bytes.readInt32BE(0));
      expect(root.uuid).toMatch(/^[a-f0-9-]{36}$/);
      expect(root.extension).toEqual(template.extension);
      expect(root['sample name']).toBe('合成样品😀');
      expect((await f.run('create', { path: target, product, template })).value.error.code).toBe(
        'FILE_EXISTS',
      );
      expect(await readFile(target)).toEqual(bytes);
    }
    const g5 = decode(await readFile(join(f.dir, 'g5.SAM')));
    const g12 = decode(await readFile(join(f.dir, 'g12.SAM')));
    expect(g5.uuid).not.toBe(g12.uuid);
  } finally {
    await f.cleanup();
  }
});

test('modify and save-as preserve extensions, provenance, identity and ordered raw units', async () => {
  const f = await setup();
  try {
    const created = await f.run('create', { template: newTemplate() });
    expect(created.code).toBe(0);
    const original = await readFile(f.path);
    const target = join(f.dir, 'copy.SAM');
    const saved = await f.run('save-as', {
      path: target,
      sourcePath: f.path,
      expectedSha256: created.value.file.sha256,
      changes: {
        'sample name': '另存😀',
        'analysis conditions': {
          'isotherm collection': {
            'absolute pressure dosing': true,
            pressures: [{ start_p: 0.76, end_p: 0.1, increment_p: 0, interval: 30 }],
          },
        },
      },
    });
    expect(saved.code).toBe(0);
    expect(saved.value.source.sha256).toBe(created.value.file.sha256);
    expect(saved.value.pressureProgram.segments[0]).toMatchObject({
      start: 760,
      end: 100,
      step: 0,
      intervalSeconds: 30,
    });
    expect(await readFile(f.path)).toEqual(original);
    const copied = decode(await readFile(target));
    expect(copied.uuid).toBe(decode(original).uuid);
    expect(copied.extension).toEqual(newTemplate().extension);
    const modified = await f.run('modify', {
      path: target,
      expectedSha256: saved.value.file.sha256,
      changes: {
        mass: { 'sample mass': 2 },
        'analysis conditions': { 'p0 and temperature options': { temperature: -195.85 } },
      },
    });
    expect(modified.code).toBe(0);
    expect(modified.value.facts.sampleMassG.value).toBe(2);
    expect(modified.value.facts.tubeMassG.value).toBe(29.1);
    expect(modified.value.facts.temperatureK.value).toBeCloseTo(77.3);
    const before = await readFile(target);
    expect(
      (
        await f.run('modify', {
          path: target,
          expectedSha256: saved.value.file.sha256,
          changes: { mass: { 'sample mass': 3 } },
        })
      ).value.error.code,
    ).toBe('FILE_CHANGED');
    expect(
      (
        await f.run('modify', {
          path: target,
          expectedSha256: modified.value.file.sha256,
          changes: { mass: { 'sample mass': -1 } },
        })
      ).value.error.code,
    ).toBe('INVALID_INPUT');
    expect(await readFile(target)).toEqual(before);
  } finally {
    await f.cleanup();
  }
});

test('create rejects incomplete or historical input and product-specific invalid configuration', async () => {
  const f = await setup();
  try {
    for (const [template, code] of [
      [sample(), 'INCOMPLETE_TEMPLATE'],
      [{ ...newTemplate(), completed: '2026/10/27 10:00:00' }, 'HISTORICAL_DATA'],
      [{ ...newTemplate(), reports: [{ result: {} }] }, 'HISTORICAL_DATA'],
      [{ ...newTemplate(), mass: { 'sample mass': 0, 'tube mass': 29 } }, 'INVALID_INPUT'],
      [
        {
          ...newTemplate(),
          'analysis conditions': { ...newTemplate()['analysis conditions'], 'analysis type': 10 },
        },
        'INVALID_INPUT',
      ],
    ] as const) {
      expect((await f.run('create', { template })).value.error.code).toBe(code);
    }
    expect((await f.run()).code).not.toBe(0);
  } finally {
    await f.cleanup();
  }
});

test('new SAM template feeds manufacturer registration followed by a separate Climber start', async () => {
  const f = await setup();
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      calls++;
      const route = new URL(request.url).pathname;
      const body = await request.json();
      if (route === '/api/v1/tasks/NEW-BATCH/start') {
        expect(calls).toBe(2);
        expect(body).toEqual({});
        return Response.json(
          { ok: true, data: { batchId: 'NEW-BATCH', state: 'STARTING', analysisStarted: false } },
          { status: 202 },
        );
      }
      expect(route).toBe('/api/v1/tasks');
      expect(body.batchId).toBe('NEW-BATCH');
      const experiment = body.experiments[0];
      expect(experiment.tubeNo).toBe(37);
      expect(experiment.samPath).toBe('//server/share/generated.SAM');
      // The mock vendor maps its shared path to the file on the agent host.
      const root = decode(await readFile(f.path));
      expect(root.mass['sample mass']).toBe(experiment.sampleMassG);
      return Response.json(
        { ok: true, data: { task: { batchId: body.batchId, state: 'READY' } } },
        { status: 201 },
      );
    },
  });
  try {
    expect(
      (
        await f.run('create', {
          settings: {
            analysisType: 'bet',
            sampleName: '新样品',
            sampleMassG: 1.5,
            tubeMassG: 29.1,
          },
        })
      ).code,
    ).toBe(0);
    const registration = {
      batchId: 'NEW-BATCH',
      experiments: [
        {
          experimentId: 'NEW-EXP',
          analysisPort: 1,
          tubeNo: 109,
          samPath: '//server/share/generated.SAM',
          sampleName: '新样品',
          emptyTubeMassG: 29.1,
          sampleMassG: 1.5,
        },
      ],
    };
    for (const [command, input] of [
      ['register', registration],
      ['start', { batchId: 'NEW-BATCH' }],
    ] as const) {
      const child = Bun.spawn(
        [
          node!,
          resolve('skills/device-automation/scripts/climber.js'),
          command,
          JSON.stringify(input),
        ],
        {
          env: {
            CLIMBER_SERVICE_URL: `${server.url.origin}/api/v1`,
            SystemRoot: process.env.SystemRoot,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(JSON.parse(output).response.ok).toBe(true);
    }
    expect(calls).toBe(2);
  } finally {
    server.stop(true);
    await f.cleanup();
  }
});

test('template creation works in the application and embedded script runtimes', async () => {
  const f = await setup();
  try {
    const runtimes: (string | string[])[] = [process.execPath];
    if (process.env.AUTO_AGENT_TEST_BINARY)
      runtimes.push([
        resolve(
          process.env.AUTO_AGENT_TEST_BINARY_PATH ??
            join('dist', process.platform === 'win32' ? 'auto-agent.exe' : 'auto-agent'),
        ),
        '--auto-agent-internal-script',
      ]);
    for (const [index, runtime] of runtimes.entries()) {
      const target = join(f.dir, `runtime-${index}.SAM`);
      const result = await f.run('create', { path: target, template: newTemplate() }, runtime);
      expect(result.code).toBe(0);
      expect(result.value.file.path).toBe(target);
      expect(decode(await readFile(target)).analysisStatus).toBe(0x1010);
      const generated = await f.run(
        'create',
        {
          path: join(f.dir, `generated-runtime-${index}.SAM`),
          settings: {
            analysisType: 'bet',
            sampleName: '生成模板',
            sampleMassG: 1.5,
            tubeMassG: 29.1,
          },
        },
        runtime,
      );
      expect(generated.code).toBe(0);
      expect(generated.value.generation.sampleInputsComplete).toBe(true);
      expect(generated.value.facts.analysisType.value).toBe('bet');
    }
  } finally {
    await f.cleanup();
  }
});

test('packaged profiles generate complete independent G5/G12 configurations without source files or caller-supplied versions', async () => {
  const f = await setup();
  try {
    const catalog = await f.run('profiles', { product: 'g12' });
    expect(catalog.code).toBe(0);
    expect(catalog.value.profiles).toHaveLength(1);
    expect(catalog.value.profiles[0]).toMatchObject({
      product: 'g12',
      softwareVersion: '2.1',
      clientVersion: '2.1.26.0416',
    });
    const uuids = new Set<string>();
    for (const product of ['g5', 'g12']) {
      for (const analysisType of ['bet', 'mesopore', 'micropore']) {
        const target = join(f.dir, `${product}-${analysisType}.SAM`);
        const result = await f.run('create', {
          path: target,
          product,
          settings: { analysisType, sampleName: '石墨😀', sampleMassG: 0.8, tubeMassG: 29.1 },
        });
        expect(result.code).toBe(0);
        expect(result.value.generation).toMatchObject({
          sampleInputsComplete: true,
          pendingInputs: [],
        });
        expect(result.value.generation.configurationOrigin.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(result.value.generation.catalogSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(result.value.facts.analysisType.value).toBe(analysisType);
        expect(result.value.facts.gasMnemonic.value).toBe('N2');
        expect(result.value.facts.freeSpaceMode.value).toBe('measured');
        expect(result.value.status.state).toBe('new');
        if (analysisType === 'bet') {
          expect(
            result.value.pressureProgram.segments.map((row: { end: number }) => row.end),
          ).toEqual([0.05, 0.1125, 0.175, 0.2375, 0.3]);
          expect(result.value.facts.lowPressureEnabled.value).toBe(false);
        } else {
          expect(result.value.pressureProgram.segments.length).toBeGreaterThan(5);
          expect(
            result.value.pressureProgram.segments.some(
              (row: { direction: string }) => row.direction === 'descending',
            ),
          ).toBe(true);
          expect(result.value.facts.lowPressureEnabled.value).toBe(analysisType === 'micropore');
        }
        const root = decode(await readFile(target));
        uuids.add(root.uuid);
        expect(root.reports).toBeNull();
        for (const key of [
          'started',
          'completed',
          'analysis data',
          'dropDatas',
          'labData',
          'serialNO',
          'firmwareVersion',
        ])
          expect(Object.hasOwn(root, key)).toBe(false);
        const conditions = root['analysis conditions'];
        expect(conditions['adsorptive properties']['molecular cross sectional area']).toBe(0.162);
        expect(conditions['p0 and temperature options']['p0 and temp dose gas']).toBe(
          conditions['adsorptive properties']['gas type'],
        );
        expect(conditions['free space options']['ambient free space']).toBe(0);
        expect(conditions['free space options']['analysis free space']).toBe(0);
        expect(conditions['isotherm collection']['advanced mode']).toBeUndefined();
      }
    }
    expect(uuids.size).toBe(6);
  } finally {
    await f.cleanup();
  }
});

test('generation can publish a draft to the configured default directory and later fill actual sample inputs', async () => {
  const f = await setup();
  try {
    const draft = await f.run('create', {
      path: undefined,
      product: 'g12',
      settings: { analysisType: 'bet' },
    });
    expect(draft.code).toBe(0);
    expect(draft.value.file.path.startsWith(join(f.dir, 'generated'))).toBe(true);
    expect(draft.value.generation.pendingInputs).toEqual([
      'sampleName',
      'sampleMassG',
      'tubeMassG',
    ]);
    expect(draft.value.generation.sampleInputsComplete).toBe(false);
    expect(draft.value.facts.sampleMassG.value).toBe(0);
    const renamed = await f.run('modify', {
      path: draft.value.file.path,
      product: 'g12',
      expectedSha256: draft.value.file.sha256,
      changes: { 'sample name': '实际样品' },
    });
    expect(renamed.code).toBe(0);
    expect(renamed.value.pendingInputs).toEqual(['sampleMassG', 'tubeMassG']);
    expect(renamed.value.sampleInputsComplete).toBe(false);
    const copied = await f.run('save-as', {
      path: join(f.dir, 'draft-copy.SAM'),
      product: 'g12',
      sourcePath: draft.value.file.path,
      expectedSha256: renamed.value.file.sha256,
    });
    expect(copied.code).toBe(0);
    expect(copied.value.pendingInputs).toEqual(['sampleMassG', 'tubeMassG']);
    expect(copied.value.sampleInputsComplete).toBe(false);
    const filled = await f.run('modify', {
      path: draft.value.file.path,
      product: 'g12',
      expectedSha256: renamed.value.file.sha256,
      changes: { 'sample name': '实际样品', mass: { 'sample mass': 1.2, 'tube mass': 28.8 } },
    });
    expect(filled.code).toBe(0);
    expect(filled.value.identity.uuid).toBe(draft.value.identity.uuid);
    expect(filled.value.facts.sampleMassG.value).toBe(1.2);
    expect(filled.value.facts.tubeMassG.value).toBe(28.8);
    expect(filled.value.sampleInputsComplete).toBe(true);
    expect(filled.value.pendingInputs).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test('normalized generation converts only pressure-table and thermal units and validates incomplete plans before writing', async () => {
  const f = await setup();
  try {
    const result = await f.run('create', {
      settings: {
        analysisType: 'micropore',
        sampleName: '样品',
        sampleMassG: 1,
        tubeMassG: 29,
        pressureMode: 'absolute-mmHg',
        pressureProgram: [
          { start: 760, end: 100, step: 0, intervalSeconds: 30 },
          { start: 100, end: 200, step: 20, intervalSeconds: 60 },
        ],
        temperatureK: 77.3,
        p0MmHg: 759,
        lowPressureEnabled: true,
        lowPressureMinHours: 0.5,
        lowPressureMaxHours: 2,
      },
    });
    expect(result.code).toBe(0);
    const root = decode(await readFile(f.path));
    const conditions = root['analysis conditions'];
    expect(conditions['isotherm collection'].pressures[0]).toEqual({
      start_p: 0.76,
      end_p: 0.1,
      increment_p: 0,
      interval: 30,
    });
    expect(conditions['p0 and temperature options'].temperature).toBeCloseTo(-195.85);
    expect(conditions['p0 and temperature options'].p0).toBe(759);
    expect(result.value.facts.lowPressureMinHours.value).toBe(0.5);
    expect(result.value.pressureProgram.segments[0].start).toBe(760);
    const before = await readFile(f.path);
    for (const settings of [
      { analysisType: 'bet', gasMnemonic: 'CO2' },
      { analysisType: 'bet', pressureMode: 'absolute-mmHg' },
      { analysisType: 'bet', sampleMassG: 0 },
      { analysisType: 'bet', temperatureK: '77' },
      { analysisType: 'bet', port: 3 },
      {
        analysisType: 'bet',
        lowPressureEnabled: true,
        lowPressureMinHours: 3,
        lowPressureMaxHours: 1,
      },
      { analysisType: 'bet', pressureProgram: [] },
    ])
      expect((await f.run('create', { settings })).code).not.toBe(0);
    expect(
      (await f.run('create', { profile: 'g12-n2-2.1.26.0416', settings: { analysisType: 'bet' } }))
        .value.error.code,
    ).toBe('UNSUPPORTED_PROFILE');
    expect(
      (await f.run('create', { template: newTemplate(), settings: { analysisType: 'bet' } })).value
        .error.code,
    ).toBe('INVALID_INPUT');
    expect(await readFile(f.path)).toEqual(before);
  } finally {
    await f.cleanup();
  }
});
