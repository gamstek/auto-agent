import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inspectSam } from './sam.js';

const fail = (code, message) => {
  throw Object.assign(new Error(message), { publicCode: code });
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const filePath = (value) =>
  typeof value === 'string' &&
  path.isAbsolute(value) &&
  /\.(sam|smp)$/i.test(value) &&
  !/[\u0000-\u001f\u007f]/.test(value);

// Arrays and null are replacements; objects merge without losing version-specific fields.
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      fail('INVALID_INPUT', '配置不能包含原型键。');
    if (object(value)) {
      if (!Object.hasOwn(target, key) || !object(target[key])) target[key] = {};
      merge(target[key], value);
    } else {
      if (typeof value === 'number' && !Number.isFinite(value))
        fail('INVALID_INPUT', '配置数值必须有限。');
      if (Array.isArray(value)) {
        // Validate nested objects as well, while preserving array order and null.
        for (const item of value) merge({}, { value: item });
      }
      target[key] = value;
    }
  }
  return target;
}

function validate(root, product, allowPendingMasses = false) {
  if (root.labType !== 0)
    fail('INVALID_INPUT', '当前厂家接口仅支持常规模式 labType=0，高通量模式1暂不支持。');
  if (typeof root['sample name'] !== 'string' || !root['sample name'].trim())
    fail('INVALID_INPUT', '样品名称必须为非空文本；待填草案使用明确占位名称。');
  if (
    !Array.isArray(root.reports) ||
    !root.reports.length ||
    root.reports.length > 64 ||
    new Set(root.reports.map((report) => report?.type)).size !== root.reports.length ||
    root.reports.some(
      (report) =>
        !object(report) ||
        !Number.isInteger(report.type) ||
        !object(report.options) ||
        report.options.type !== report.type ||
        typeof report.options.selected !== 'boolean' ||
        typeof report.options.name !== 'string' ||
        !report.options.name.trim(),
    ) ||
    !root.reports.some((report) => report.options.selected === true)
  )
    fail(
      'INVALID_REPORT_OPTIONS',
      '模板需要1–64项完整 reports[].options，type需一致且至少勾选一项；不能清空报告配置。',
    );
  const conditions = root['analysis conditions'];
  if (!object(conditions) || !object(conditions['isotherm collection']))
    fail('NOT_SAMPLE_TEMPLATE', '需要完整的样品实验配置。');
  const collection = conditions['isotherm collection'];
  if (
    typeof collection['absolute pressure dosing'] !== 'boolean' ||
    typeof collection['use target pressure'] !== 'boolean'
  )
    fail('INVALID_INPUT', '必须明确压力模式和采集模式。');
  const typeCodes =
    product === 'g5' ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] : [0, 1, 2, 3, 4, 9, 10, 11, 12, 13];
  if (!typeCodes.includes(conditions['analysis type']))
    fail('INVALID_INPUT', '实验类型不属于所选产品的当前枚举。');
  const free = conditions['free space options'];
  if (
    !object(free) ||
    !(product === 'g5' ? [0, 1, 2] : [0, 1, 2, 3]).includes(free['free space option type'])
  )
    fail('INVALID_INPUT', '自由空间模式不属于所选产品的当前枚举。');
  for (const key of ['sample mass', 'tube mass'])
    if (
      !object(root.mass) ||
      !Number.isFinite(root.mass[key]) ||
      (allowPendingMasses ? root.mass[key] < 0 : root.mass[key] <= 0)
    )
      fail('INVALID_INPUT', '样品和空管质量必须为正数（g）；生成草案允许待填的0值。');
  const table = collection[collection['use target pressure'] ? 'pressures' : 'increments'];
  if (!Array.isArray(table) || !table.length || table.length > 256)
    fail('INVALID_SEGMENTS', '当前采集模式需要1–256段程序。');
  for (const row of table) {
    const fields = collection['use target pressure']
      ? ['start_p', 'end_p', 'increment_p', 'interval']
      : ['end_p', 'dose increment', 'percent of previous', 'interval'];
    if (
      !object(row) ||
      fields.some((key) => !Number.isFinite(row[key]) || row[key] < 0) ||
      !Number.isInteger(row.interval) ||
      row.interval <= 0 ||
      (!collection['use target pressure'] && typeof row['use dose increment'] !== 'boolean')
    )
      fail('INVALID_SEGMENTS', '压力/注气段数值、模式或秒间隔无效。');
  }
  const options = collection.options;
  for (const prefix of ['T_', 'D_']) {
    if (options?.[prefix + 'LPressIncrementalDoseMode'] === true) {
      const [dose, min, max] = ['DoseAmount', 'MinEquilibrationDelay', 'MaxEquilibrationDelay'].map(
        (k) => options[prefix + k],
      );
      if (![dose, min, max].every((v) => Number.isFinite(v) && v >= 0) || min > max)
        fail('INVALID_INPUT', '低压注气量或小时延时范围无效。');
    }
  }
}

export async function writeSam(input, command) {
  if (!['create', 'modify', 'save-as'].includes(command) || !object(input))
    fail('INVALID_INPUT', '需要模板写入命令及 JSON 对象。');
  let generated;
  if (command === 'create' && Object.hasOwn(input, 'settings')) {
    generated = await (await import('./sam-generate.js')).generateSam(input);
    input = generated.input;
  }
  const required =
    command === 'create'
      ? ['path', 'product', 'template']
      : command === 'modify'
        ? ['path', 'product', 'expectedSha256']
        : ['path', 'product', 'sourcePath', 'expectedSha256'];
  const optional = command === 'create' ? [] : ['changes', 'reportTypes'];
  if (
    required.some((k) => !Object.hasOwn(input, k)) ||
    Object.keys(input).some((k) => ![...required, ...optional].includes(k)) ||
    !filePath(input.path) ||
    !['g5', 'g12'].includes(input.product)
  )
    fail('INVALID_INPUT', '需要绝对 SAM/SMP 路径、g5/g12 产品及命令要求的字段。');
  if (command === 'modify' && input.changes === undefined && input.reportTypes === undefined)
    fail('INVALID_INPUT', 'modify 需要 changes 或 reportTypes。');
  if (
    input.reportTypes !== undefined &&
    object(input.changes) &&
    Object.hasOwn(input.changes, 'reports')
  )
    fail('INVALID_INPUT', 'reportTypes 与 changes.reports 不能同时提供。');
  if (
    command !== 'create' &&
    (!/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
      (command === 'save-as' && !filePath(input.sourcePath)))
  )
    fail('INVALID_INPUT', '需要源文件当前 SHA-256 和有效源路径。');
  if (
    (command === 'create' && !object(input.template)) ||
    (input.changes !== undefined && !object(input.changes))
  )
    fail('INVALID_INPUT', 'template/changes 必须为对象。');
  const requested = command === 'create' ? input.template : input.changes;
  if (requested && Object.hasOwn(requested, 'labType') && requested.labType !== 0)
    fail(
      'INVALID_INPUT',
      '当前厂家接口仅支持常规模式 labType=0；高通量模式1暂不支持，不能指定非0值。',
    );

  let root, status, source;
  if (command === 'create') {
    root = merge({}, input.template);
    status = input.product === 'g5' ? 0x1010 : 0x2010;
    for (const key of [
      'started',
      'completed',
      'reportTime',
      'analysis data',
      'dropDatas',
      'labData',
    ])
      if (
        root[key] != null &&
        root[key] !== '' &&
        ((!object(root[key]) && !Array.isArray(root[key])) || Object.keys(root[key]).length)
      )
        fail('HISTORICAL_DATA', '新建配置应提供实验前配置，不携带历史运行时间或结果。');
    if (!Array.isArray(root.reports))
      fail('INVALID_REPORT_OPTIONS', '新建模板必须提供完整 reports 数组，不能清为 null。');
    if (root.reports?.some((report) => report?.result != null))
      fail('HISTORICAL_DATA', '新建配置不能携带报告结果。');
    for (const key of ['mass', 'sample tube'])
      if (!object(root[key])) fail('INCOMPLETE_TEMPLATE', `新建配置缺少 ${key}。`);
    for (const key of [
      'adsorptive properties',
      'preparation options',
      'free space options',
      'p0 and temperature options',
      'sample backfill options',
    ])
      if (!object(root['analysis conditions']?.[key]))
        fail('INCOMPLETE_TEMPLATE', `新建配置缺少 ${key}；请使用对应产品的完整配置。`);
    if (
      ![root.softwareVersion, root.clientVersion, root['sample name']].every(
        (v) => typeof v === 'string' && v.trim(),
      )
    )
      fail('INCOMPLETE_TEMPLATE', '新建配置需要样品名称及实际软件/客户端版本。');
    root.uuid = randomUUID();
    root.analysisStatus = status;
  } else {
    const sourcePath = command === 'modify' ? input.path : input.sourcePath;
    source = await inspectSam({ path: sourcePath, product: input.product });
    if (source.status.family !== input.product)
      fail('PRODUCT_STATUS_MISMATCH', '源文件状态家族必须与所选产品一致。');
    if (source.file.sha256 !== input.expectedSha256)
      fail('FILE_CHANGED', '源文件哈希不匹配，请重新核对。');
    const bytes = await fs.readFile(sourcePath);
    if (hash(bytes) !== input.expectedSha256) fail('FILE_CHANGED', '源文件在读取时发生变化。');
    root = JSON.parse(
      source.file.format === 'utf8-json'
        ? bytes.toString('utf8').replace(/^\ufeff/, '')
        : new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(8)),
    );
    status = source.status.raw;
    if (
      input.changes &&
      [
        'uuid',
        'analysisStatus',
        'started',
        'completed',
        'analysis data',
        'dropDatas',
        'labData',
      ].some((k) => Object.hasOwn(input.changes, k))
    )
      fail('INVALID_INPUT', '修改保留实验身份、状态和运行证据；新实验使用 create。');
    merge(root, input.changes ?? {});
    if (input.reportTypes !== undefined) {
      const types = input.reportTypes;
      if (
        !Array.isArray(types) ||
        !types.length ||
        new Set(types).size !== types.length ||
        !Array.isArray(root.reports) ||
        types.some(
          (type) =>
            !Number.isInteger(type) ||
            !root.reports.some((report) => report?.type === type && object(report.options)),
        )
      )
        fail('INVALID_INPUT', 'reportTypes 必须为源文件已有报告类型的非空、无重复整数数组。');
      for (const report of root.reports) {
        if (!object(report.options))
          fail('INVALID_REPORT_OPTIONS', '源报告缺少完整 options，不能仅补 selected。');
        report.options.selected = types.includes(report.type);
      }
    }
  }
  const normalizedFields = root.labType === 0 ? [] : ['labType'];
  root.labType = 0;
  validate(root, input.product, Boolean(generated) || source?.status.state === 'new');
  const body = Buffer.from(JSON.stringify(root), 'utf16le').swap16();
  const header = Buffer.alloc(8);
  header.writeInt32BE(status, 0);
  header.writeUInt32BE(body.length, 4);
  const bytes = Buffer.concat([header, body]);
  if (bytes.length > 32 * 1024 * 1024) fail('FILE_TOO_LARGE', '模板超过32 MiB。');
  const parent = path.dirname(input.path);
  if (generated?.directory) await fs.mkdir(generated.directory, { recursive: true });
  const temporary = path.join(parent, `.sam-${randomUUID()}.SAM`);
  let created = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      if (command === 'modify') await handle.chmod((await fs.stat(input.path)).mode & 0o777);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const summary = await inspectSam({ path: temporary, product: input.product });
    const pendingInputs = [
      ...(root['sample name'] === '未命名样品' ? ['sampleName'] : []),
      ...(root.mass['sample mass'] > 0 ? [] : ['sampleMassG']),
      ...(root.mass['tube mass'] > 0 ? [] : ['tubeMassG']),
    ];
    const result = {
      ...summary,
      backend: 'sam-file-write',
      operation: command,
      file: { ...summary.file, path: input.path },
      ...(source ? { source: source.file } : {}),
      ...(generated
        ? {
            generation: {
              ...generated.generation,
              pendingInputs,
              sampleInputsComplete: pendingInputs.length === 0,
            },
          }
        : {}),
      pendingInputs,
      sampleInputsComplete: pendingInputs.length === 0,
      normalizedFields,
      written: true,
      executionVerified: false,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 60000)
      fail('OUTPUT_TOO_LARGE', '完整配置与生成来源超过输出上限，未发布目标文件。');
    if (command === 'modify') {
      const current = await inspectSam({ path: input.path, product: input.product });
      if (current.file.sha256 !== input.expectedSha256)
        fail('FILE_CHANGED', '目标文件已变化，未覆盖。');
      await fs.rename(temporary, input.path);
    } else {
      // A hard link publishes the complete file without replacing an existing destination.
      try {
        await fs.link(temporary, input.path);
      } catch (error) {
        if (error.code === 'EEXIST') fail('FILE_EXISTS', '目标已存在；新建和另存为不覆盖文件。');
        throw error;
      }
    }
    return result;
  } finally {
    if (created) await fs.unlink(temporary).catch(() => {});
  }
}
