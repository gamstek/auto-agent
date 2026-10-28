import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const fail = (code, message) => {
  throw Object.assign(new Error(message), { publicCode: code });
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value);
const outputDirectory = () => {
  const directory = process.env.SAM_OUTPUT_DIR ?? path.join(homedir(), 'Auto-Agent', 'templates');
  if (!path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory))
    fail('INVALID_INPUT', 'SAM_OUTPUT_DIR 必须是绝对目录。');
  return directory;
};
async function catalog() {
  const bytes = await readFile(new URL('./sam-profiles.json', import.meta.url));
  const value = JSON.parse(bytes.toString('utf8'));
  return { ...value, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function samProfiles(input) {
  if (
    !object(input) ||
    Object.keys(input).some((key) => key !== 'product') ||
    (input.product !== undefined && !['g5', 'g12'].includes(input.product))
  )
    fail('INVALID_INPUT', 'profiles 接受 {} 或 {product:"g5"/"g12"}。');
  const data = await catalog();
  return {
    backend: 'sam-profile-catalog',
    revision: data.revision,
    sha256: data.sha256,
    defaultOutputDirectory: outputDirectory(),
    profiles: data.profiles
      .filter((profile) => !input.product || profile.product === input.product)
      .map((profile) => ({
        id: profile.id,
        product: profile.product,
        gasMnemonic: profile.gas,
        softwareVersion: profile.configuration.softwareVersion,
        clientVersion: profile.configuration.clientVersion,
        methods: Object.keys(data.programs),
        origin: profile.origin,
        defaults: {
          temperatureK:
            profile.configuration['analysis conditions']['p0 and temperature options'].temperature +
            273.15,
          p0MmHg: profile.configuration['analysis conditions']['p0 and temperature options'].p0,
          freeSpaceMode: 'measured',
          sampleTube: profile.configuration['sample tube'],
        },
      })),
    executionVerified: false,
  };
}

export async function generateSam(input) {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !['path', 'product', 'profile', 'settings'].includes(key)) ||
    !['g5', 'g12'].includes(input.product) ||
    !object(input.settings)
  )
    fail('INVALID_INPUT', '按需新建需要 product 和 settings，不需要基准文件。');
  const settings = input.settings;
  const allowed = [
    'analysisType',
    'gasMnemonic',
    'sampleName',
    'sampleMassG',
    'tubeMassG',
    'sampleDensityGPerCm3',
    'unit',
    'port',
    'temperatureK',
    'p0MmHg',
    'pressureMode',
    'pressureProgram',
    'preparationEvacuationHours',
    'lowPressureEnabled',
    'lowPressureDoseCm3StpPerG',
    'lowPressureMinHours',
    'lowPressureMaxHours',
  ];
  if (
    Object.keys(settings).some((key) => !allowed.includes(key)) ||
    !['bet', 'mesopore', 'micropore'].includes(settings.analysisType)
  )
    fail('INVALID_INPUT', 'settings 需要 analysisType（bet/mesopore/micropore）及已支持的参数。');
  if (settings.gasMnemonic !== undefined && settings.gasMnemonic !== 'N2')
    fail(
      'UNSUPPORTED_PROFILE',
      '内置完整物性目前为 N2；其他气体请提供成套配置，不能只替换气体名称。',
    );
  for (const key of ['sampleName'])
    if (settings[key] !== undefined && !text(settings[key]))
      fail('INVALID_INPUT', `${key} 必须为有效文本。`);
  for (const key of [
    'sampleMassG',
    'tubeMassG',
    'sampleDensityGPerCm3',
    'temperatureK',
    'p0MmHg',
    'preparationEvacuationHours',
    'lowPressureDoseCm3StpPerG',
    'lowPressureMinHours',
    'lowPressureMaxHours',
  ])
    if (
      settings[key] !== undefined &&
      (typeof settings[key] !== 'number' ||
        !Number.isFinite(settings[key]) ||
        (key.startsWith('lowPressure') || key === 'preparationEvacuationHours'
          ? settings[key] < 0
          : settings[key] <= 0))
    )
      fail('INVALID_INPUT', `${key} 数值或单位不合法。`);
  if (
    (settings.unit !== undefined && ![1, 2].includes(settings.unit)) ||
    (settings.port !== undefined &&
      (!Number.isInteger(settings.port) ||
        settings.port < 0 ||
        settings.port > (input.product === 'g5' ? 2 : 3)))
  )
    fail('INVALID_INPUT', 'unit/port 超出产品范围；port 从0起始。');
  if (settings.lowPressureEnabled !== undefined && typeof settings.lowPressureEnabled !== 'boolean')
    fail('INVALID_INPUT', 'lowPressureEnabled 必须为布尔值。');
  if (
    settings.pressureMode !== undefined &&
    !['relative-pp0', 'absolute-mmHg'].includes(settings.pressureMode)
  )
    fail('INVALID_INPUT', 'pressureMode 无效。');
  if (
    settings.pressureProgram !== undefined &&
    (!settings.pressureMode ||
      !Array.isArray(settings.pressureProgram) ||
      !settings.pressureProgram.length ||
      settings.pressureProgram.length > 256 ||
      settings.pressureProgram.some(
        (row) =>
          !object(row) ||
          Object.keys(row).length !== 4 ||
          !['start', 'end', 'step', 'intervalSeconds'].every(
            (key) =>
              Object.hasOwn(row, key) &&
              typeof row[key] === 'number' &&
              Number.isFinite(row[key]) &&
              row[key] >= 0,
          ) ||
          !Number.isInteger(row.intervalSeconds) ||
          row.intervalSeconds <= 0,
      ))
  )
    fail(
      'INVALID_SEGMENTS',
      'pressureProgram 需要 pressureMode 和1–256个有序 start/end/step/intervalSeconds 段。',
    );
  if (settings.pressureMode === 'absolute-mmHg' && settings.pressureProgram === undefined)
    fail('INVALID_INPUT', '改为绝对压力时必须明确给出 mmHg 压力程序，不重解释内置相对压力点。');

  const data = await catalog();
  const profile = data.profiles.find(
    (candidate) =>
      candidate.product === input.product &&
      (input.profile === undefined || candidate.id === input.profile),
  );
  if (!profile)
    fail('UNSUPPORTED_PROFILE', '没有匹配的产品/版本配置；先用 profiles 查询可用配置。');
  const program = data.programs[settings.analysisType];
  const root = structuredClone(profile.configuration);
  const conditions = root['analysis conditions'];
  conditions['analysis type'] =
    settings.analysisType === 'bet'
      ? 0
      : settings.analysisType === 'mesopore'
        ? 1
        : input.product === 'g5'
          ? 5
          : 10;
  conditions['isotherm collection'] = structuredClone(program.collection);
  const collection = conditions['isotherm collection'];
  if (settings.pressureProgram !== undefined) {
    const scale = settings.pressureMode === 'absolute-mmHg' ? 1000 : 1;
    collection['absolute pressure dosing'] = scale === 1000;
    collection.pressures = settings.pressureProgram.map((row) => ({
      start_p: row.start / scale,
      end_p: row.end / scale,
      increment_p: row.step / scale,
      interval: row.intervalSeconds,
    }));
  }
  const thermal = conditions['p0 and temperature options'];
  if (settings.temperatureK !== undefined) thermal.temperature = settings.temperatureK - 273.15;
  if (settings.p0MmHg !== undefined) thermal.p0 = settings.p0MmHg;
  if (settings.preparationEvacuationHours !== undefined)
    conditions['preparation options']['evacuation time'] = settings.preparationEvacuationHours;
  for (const [field, raw] of Object.entries({
    lowPressureEnabled: 'T_LPressIncrementalDoseMode',
    lowPressureDoseCm3StpPerG: 'T_DoseAmount',
    lowPressureMinHours: 'T_MinEquilibrationDelay',
    lowPressureMaxHours: 'T_MaxEquilibrationDelay',
  }))
    if (settings[field] !== undefined) collection.options[raw] = settings[field];
  root.mass = {
    ...root.mass,
    'sample mass': settings.sampleMassG ?? 0,
    'tube mass': settings.tubeMassG ?? 0,
  };
  if (settings.sampleDensityGPerCm3 !== undefined)
    root.mass.density = settings.sampleDensityGPerCm3;
  root['sample name'] = settings.sampleName ?? '未命名样品';
  root.unit = settings.unit ?? 1;
  root.port = settings.port ?? 0;
  root.manuallyImport = false;
  root['base infos'] = null;
  root.reports = null;
  root['review the reports after the test'] = false;
  let target = input.path;
  if (target === undefined) {
    target = path.join(outputDirectory(), `${settings.analysisType}-${randomUUID()}.SAM`);
  }
  if (
    typeof target !== 'string' ||
    !path.isAbsolute(target) ||
    !/\.(sam|smp)$/i.test(target) ||
    /[\u0000-\u001f\u007f]/.test(target)
  )
    fail('INVALID_INPUT', 'path 必须为绝对 SAM/SMP 路径。');
  const directory = path.dirname(target);
  root['save path'] = directory;
  const pendingInputs = ['sampleName', 'sampleMassG', 'tubeMassG'].filter(
    (key) => settings[key] === undefined,
  );
  return {
    input: { path: target, product: input.product, template: root },
    directory,
    generation: {
      profile: profile.id,
      catalogSha256: data.sha256,
      configurationOrigin: profile.origin,
      programOrigin: program.origin,
      requestedSettings: settings,
      defaultedFields: [
        'gasMnemonic',
        'unit',
        'port',
        'temperatureK',
        'p0MmHg',
        'pressureProgram',
        'sampleDensityGPerCm3',
        'preparationEvacuationHours',
        'lowPressureEnabled',
        'lowPressureDoseCm3StpPerG',
        'lowPressureMinHours',
        'lowPressureMaxHours',
      ].filter((key) => settings[key] === undefined),
      pendingInputs,
      sampleInputsComplete: pendingInputs.length === 0,
    },
  };
}
