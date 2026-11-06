import { createHash } from 'node:crypto';
import { WikiError as AppError } from '@auto-agent/wiki-core/contracts';

type ObjectValue = Record<string, any>;
type Scalar = string | number | boolean | null;
interface Fact {
  value: Scalar;
  source: string[];
  presence: 'missing' | 'null' | 'value';
  rawValue?: Scalar;
  unit?: string;
}
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const fail = (code: string, message: string): never => {
  throw new AppError(code, message);
};
const states: Record<number, string> = {
  0x10: 'new',
  0x20: 'analysing',
  0x40: 'completed',
  0x80: 'interrupted',
  0x100: 'imported',
  0x200: 'adsorptive-parameters',
  0x400: 'tube-parameters',
};
const methods: Record<string, Record<number, string>> = {
  g5: {
    0: 'bet',
    1: 'mesopore',
    2: 'ambient-free-space',
    3: 'analysis-free-space',
    4: 'p0',
    5: 'micropore',
    6: 'empty-tube',
    7: 'fast-bet',
    8: 'fast-mesopore',
    9: 'fast-micropore',
  },
  g12: {
    0: 'bet',
    1: 'mesopore',
    2: 'ambient-free-space',
    3: 'analysis-free-space',
    4: 'p0',
    10: 'micropore',
    9: 'empty-tube',
    11: 'fast-bet',
    12: 'fast-mesopore',
    13: 'fast-micropore',
  },
};
const freeModes: Record<string, Record<number, string>> = {
  g5: { 0: 'measured', 1: 'manual', 2: 'calculated' },
  g12: { 0: 'measured', 1: 'post-calibration', 2: 'manual', 3: 'calculated' },
};

/** Pure Wiki decoder. The indexer owns filesystem confinement and the byte snapshot. */
export function decodeSam(bytes: Uint8Array) {
  if (bytes.byteLength > 32 * 1024 * 1024) fail('FILE_TOO_LARGE', 'Template exceeds 32 MiB');
  if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '^vMIC')
    fail('UNSUPPORTED_FORMAT', 'Foreign SMP format is not a Qt SAM template');
  if (bytes.byteLength < 8) fail('INVALID_HEADER', 'Template header is incomplete');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const status = view.getInt32(0, false),
    length = view.getUint32(4, false);
  const product: 'g5' | 'g12' | null =
    status >= 0x1000 && status < 0x2000 ? 'g5' : status >= 0x2000 && status < 0x3000 ? 'g12' : null;
  if (!product)
    fail('UNSUPPORTED_FORMAT', 'Cannot establish a documented SAM product family from the header');
  if (length === 0xffffffff) fail('EMPTY_TEMPLATE', 'Template QString is null');
  if (length % 2 || length !== bytes.byteLength - 8)
    fail('INVALID_HEADER', 'Template QString length does not match file size');
  let text: string;
  try {
    text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(8));
  } catch {
    return fail('INVALID_ENCODING', 'Template QString is not valid UTF-16BE');
  }
  let root: unknown;
  try {
    root = JSON.parse(text, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite number');
      return value;
    });
  } catch {
    return fail('INVALID_JSON', 'Template contains invalid JSON or nonfinite numbers');
  }
  if (!object(root)) return fail('INVALID_JSON', 'Template JSON root must be an object');
  if (
    !object(root['analysis conditions']) ||
    !object(root['analysis conditions']['isotherm collection'])
  )
    fail('NOT_SAMPLE_TEMPLATE', 'Template lacks sample analysis conditions');
  const state = states[status - (product === 'g5' ? 0x1000 : 0x2000)] ?? 'unknown';
  if (['adsorptive-parameters', 'tube-parameters'].includes(state))
    fail('NOT_SAMPLE_TEMPLATE', 'Parameter template is not a sample template');
  return { root, product: product!, status, state };
}

/** Stable reference summary, independent of portable skill commands and their output budgets. */
export function summarizeSam(
  decoded: ReturnType<typeof decodeSam>,
  bytes: Uint8Array,
  path: string,
) {
  const { root, product, status, state } = decoded;
  const conditions = root['analysis conditions'];
  const collection = conditions['isotherm collection'];
  const facts: Record<string, Fact> = {};
  const warnings: { code: string; message: string }[] = [];
  const warn = (code: string, message: string) => {
    if (!warnings.some((item) => item.code === code)) warnings.push({ code, message });
  };
  const fact = (
    name: string,
    source: string[],
    transform: (value: any) => Scalar,
    unit?: string,
  ) => {
    let raw: any = root,
      present = true;
    for (const key of source) {
      if (!object(raw) || !Object.hasOwn(raw, key)) {
        present = false;
        break;
      }
      raw = raw[key];
    }
    facts[name] = {
      value: present ? transform(raw) : null,
      source,
      presence: !present ? 'missing' : raw === null ? 'null' : 'value',
      ...(present && (raw === null || ['string', 'number', 'boolean'].includes(typeof raw))
        ? { rawValue: raw }
        : {}),
      ...(unit ? { unit } : {}),
    };
  };
  const text = (v: unknown) => (typeof v === 'string' ? v : null);
  const numeric = (v: unknown) => (number(v) ? v : null);
  const base = ['analysis conditions', 'isotherm collection'];
  const mode =
    typeof collection['absolute pressure dosing'] === 'boolean'
      ? collection['absolute pressure dosing']
        ? 'absolute-mmHg'
        : 'relative-pp0'
      : null;
  const acquisition =
    typeof collection['use target pressure'] === 'boolean'
      ? collection['use target pressure']
        ? 'target-pressure'
        : 'dose-increment'
      : null;
  fact('softwareVersion', ['softwareVersion'], text);
  fact('clientVersion', ['clientVersion'], text);
  fact('labType', ['labType'], (v) => (Number.isInteger(v) ? v : null));
  fact('analysisType', ['analysis conditions', 'analysis type'], (v) =>
    Number.isInteger(v) ? (methods[product]![v] ?? null) : null,
  );
  fact('gasMnemonic', ['analysis conditions', 'adsorptive properties', 'mnemonic'], text);
  fact(
    'temperatureK',
    ['analysis conditions', 'p0 and temperature options', 'temperature'],
    (v) => (number(v) ? v + 273.15 : null),
    'K (source: °C)',
  );
  fact('p0MmHg', ['analysis conditions', 'p0 and temperature options', 'p0'], numeric, 'mmHg');
  fact(
    'maximumManifoldPressureMmHg',
    ['analysis conditions', 'adsorptive properties', 'maximum manifold pressure'],
    numeric,
    'mmHg',
  );
  fact(
    'absolutePressureToleranceMmHg',
    [...base, 'options', 'absolute pressure tolerance'],
    numeric,
    'mmHg',
  );
  fact('sampleMassG', ['mass', 'sample mass'], numeric, 'g');
  fact('tubeMassG', ['mass', 'tube mass'], numeric, 'g');
  fact('pressureMode', [...base, 'absolute pressure dosing'], () => mode);
  fact('collectionMode', [...base, 'use target pressure'], () => acquisition);
  fact(
    'freeSpaceMode',
    ['analysis conditions', 'free space options', 'free space option type'],
    (v) => (Number.isInteger(v) ? (freeModes[product]![v] ?? null) : null),
  );
  const prefix =
    acquisition === 'target-pressure' ? 'T_' : acquisition === 'dose-increment' ? 'D_' : null;
  fact(
    'lowPressureEnabled',
    [...base, 'options', prefix ? prefix + 'LPressIncrementalDoseMode' : '(mode unknown)'],
    (v) => (typeof v === 'boolean' ? v : null),
  );
  for (const [name, key, unit] of [
    ['lowPressureDoseCm3StpPerG', 'DoseAmount', 'cm³(STP)/g'],
    ['lowPressureMinHours', 'MinEquilibrationDelay', 'h'],
    ['lowPressureMaxHours', 'MaxEquilibrationDelay', 'h'],
  ])
    fact(
      name!,
      [...base, 'options', prefix ? prefix + key : '(mode unknown)'],
      (v) => (facts.lowPressureEnabled!.value === true ? numeric(v) : null),
      unit,
    );
  const pressure = (value: unknown) =>
    number(value) && mode !== null ? value * (mode === 'absolute-mmHg' ? 1000 : 1) : null;
  const segments = (kind: 'pressures' | 'increments') => {
    const value = collection[kind];
    if (value == null) return null;
    if (!Array.isArray(value) || value.length > 256)
      return fail(
        'INVALID_SEGMENTS',
        'Reference pressure/increment table must contain at most 256 rows',
      );
    return value.map((row, index) => {
      if (!object(row)) return fail('INVALID_SEGMENTS', 'Reference segment must be an object');
      const keys =
        kind === 'pressures'
          ? ['start_p', 'end_p', 'increment_p', 'interval']
          : ['end_p', 'dose increment', 'percent of previous', 'interval'];
      const extraKeys = Object.keys(row).filter(
        (key) => ![...keys, 'use dose increment'].includes(key),
      );
      if (extraKeys.length)
        warn(
          'UNINTERPRETED_SEGMENT_FIELDS',
          'Segment extensions are not interpreted as executable settings.',
        );
      return {
        index,
        raw: Object.fromEntries(
          keys.filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]),
        ),
        ...(kind === 'pressures'
          ? {
              start: pressure(row.start_p),
              end: pressure(row.end_p),
              step: pressure(row.increment_p),
              intervalSeconds: numeric(row.interval),
              direction:
                number(row.start_p) && number(row.end_p)
                  ? row.start_p > row.end_p
                    ? 'descending'
                    : 'ascending'
                  : null,
              endpointOnly: row.increment_p === 0,
            }
          : {
              end: pressure(row.end_p),
              useDoseIncrement:
                typeof row['use dose increment'] === 'boolean' ? row['use dose increment'] : null,
            }),
        extraKeys,
        source: [...base, kind, index],
      };
    });
  };
  const pressures = segments('pressures'),
    increments = segments('increments');
  if (Array.isArray(root.reports) && root.reports.length > 64)
    fail('OUTPUT_TOO_LARGE', 'Reference report list exceeds 64 entries');
  warn(
    'VERSION_NOT_VERIFIED',
    'Product enums follow documented definitions; historical software compatibility and execution are not verified.',
  );
  if (state !== 'new')
    warn('NOT_NEW_TEMPLATE', 'Historical file state is not current instrument state.');
  if (root.analysisStatus !== undefined && root.analysisStatus !== status)
    warn('STATUS_MISMATCH', 'Header and JSON analysisStatus differ.');
  if (Object.hasOwn(root, 'labType') && root.labType !== 0)
    warn(
      'UNSUPPORTED_LAB_TYPE',
      'Historical labType is preserved: 0 regular, 1 high-throughput; the current manufacturer API requires regular mode.',
    );
  if (Object.values(facts).some((field) => field.value === null))
    warn(
      'UNRESOLVED_FIELDS',
      'Some fields are missing, inactive or unrecognized; no defaults substituted.',
    );
  if (
    root.started ||
    root.completed ||
    ['analysis data', 'dropDatas', 'labData'].some(
      (key) => root[key] && Object.keys(root[key]).length,
    )
  )
    warn('HISTORICAL_DATA', 'Historical run times/results are not evidence of a new execution.');
  const presence = (key: string) =>
    !Object.hasOwn(collection, key) ? 'missing' : collection[key] === null ? 'null' : 'value';
  return {
    backend: 'sam-reference-summary',
    operation: 'index',
    executionVerified: false,
    file: {
      path,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      format: 'qt-utf16be-json',
    },
    interpretation: { product, basis: 'SAM/SMP字段说明2026-10-27', versionVerified: false },
    status: { raw: status, family: product, state, analysisStatus: root.analysisStatus ?? null },
    identity: {
      sampleName: root['sample name'] ?? null,
      uuid: typeof root.uuid === 'string' ? root.uuid : null,
      unit: root.unit ?? null,
      port: root.port ?? null,
    },
    facts,
    pressureProgram: {
      presence: presence('pressures'),
      active: acquisition === null ? null : acquisition === 'target-pressure',
      unit: mode === null ? null : mode === 'absolute-mmHg' ? 'mmHg' : 'P/P0',
      segments: pressures,
    },
    incrementProgram: {
      presence: presence('increments'),
      active: acquisition === null ? null : acquisition === 'dose-increment',
      doseUnit: 'cm³(STP)/g',
      timeUnit: 's',
      segments: increments,
    },
    reports: Array.isArray(root.reports)
      ? root.reports.map((r: any) => ({
          type: r?.type ?? null,
          name: r?.options?.name ?? null,
          selected: typeof r?.options?.selected === 'boolean' ? r.options.selected : null,
        }))
      : null,
    warnings,
  };
}
