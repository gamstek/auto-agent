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
        JSON.stringify({ path, product: 'g5', ...extra }),
      ],
      {
        cwd: f.dir,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { SystemRoot: globalThis.process.env.SystemRoot },
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
