export async function inspectSam(input, command = 'inspect') {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const path = await import('node:path');
  const { createHash } = await import('node:crypto');
  const fail = (code, message) => {
    throw Object.assign(new Error(message), { publicCode: code });
  };
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const string = (v) =>
    typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v);
  const keys = (v, required, optional = []) =>
    object(v) &&
    required.every((k) => Object.hasOwn(v, k)) &&
    Object.keys(v).every((k) => required.includes(k) || optional.includes(k));
  if (!['inspect', 'compare'].includes(command))
    fail('INVALID_COMMAND', '使用 inspect 或 compare，并传入一个 JSON 参数。');
  if (
    !keys(
      input,
      command === 'compare' ? ['path', 'product', 'requirements'] : ['path', 'product'],
      command === 'compare' ? ['tolerances'] : [],
    ) ||
    !string(input.path) ||
    !path.isAbsolute(input.path) ||
    !/\.(sam|smp)$/i.test(input.path) ||
    !['g5', 'g12', 's60pro'].includes(input.product)
  )
    fail('INVALID_INPUT', '需要当前主机可读的绝对 SAM/SMP 路径和 product（g5/g12/s60pro）。');

  const numericFields = [
    'temperatureK',
    'p0MmHg',
    'maximumManifoldPressureMmHg',
    'absolutePressureToleranceMmHg',
    'sampleMassG',
    'tubeMassG',
    'lowPressureDoseCm3StpPerG',
    'lowPressureMinHours',
    'lowPressureMaxHours',
  ];
  const textFields = [
    'analysisType',
    'gasMnemonic',
    'pressureMode',
    'collectionMode',
    'freeSpaceMode',
    'softwareVersion',
    'clientVersion',
  ];
  const enums = {
    analysisType: [
      'bet',
      'mesopore',
      'micropore',
      'ambient-free-space',
      'analysis-free-space',
      'p0',
      'empty-tube',
      'fast-bet',
      'fast-mesopore',
      'fast-micropore',
    ],
    pressureMode: ['relative-pp0', 'absolute-mmHg'],
    collectionMode: ['target-pressure', 'dose-increment'],
    freeSpaceMode: ['measured', 'post-calibration', 'manual', 'calculated'],
  };
  if (command === 'compare') {
    const r = input.requirements;
    if (
      !object(r) ||
      !Object.keys(r).length ||
      !Object.keys(r).every((k) =>
        [...numericFields, ...textFields, 'lowPressureEnabled', 'pressureProgram'].includes(k),
      )
    )
      fail('INVALID_INPUT', 'requirements 必须包含已支持的对比字段，且不能为空。');
    for (const [key, value] of Object.entries(r)) {
      if (
        numericFields.includes(key) &&
        (!finite(value) || (key.startsWith('lowPressure') ? value < 0 : value <= 0))
      )
        fail('INVALID_INPUT', `${key} 数值不合法。`);
      if (
        textFields.includes(key) &&
        (!string(value) || (enums[key] && !enums[key].includes(value)))
      )
        fail('INVALID_INPUT', `${key} 值不合法。`);
      if (key === 'lowPressureEnabled' && typeof value !== 'boolean')
        fail('INVALID_INPUT', 'lowPressureEnabled 必须为布尔值。');
      if (
        key === 'pressureProgram' &&
        (!r.pressureMode ||
          !Array.isArray(value) ||
          value.length > 256 ||
          !value.every(
            (segment) =>
              keys(segment, ['start', 'end', 'step', 'intervalSeconds']) &&
              Object.values(segment).every(finite) &&
              segment.start >= 0 &&
              segment.end >= 0 &&
              segment.step >= 0 &&
              Number.isInteger(segment.intervalSeconds) &&
              segment.intervalSeconds > 0,
          ))
      )
        fail(
          'INVALID_INPUT',
          'pressureProgram 需要 pressureMode 和至多 256 个有序压力段（start/end/step/intervalSeconds）。',
        );
    }
    if (
      input.tolerances !== undefined &&
      (!object(input.tolerances) ||
        Object.entries(input.tolerances).some(
          ([key, value]) =>
            !numericFields.includes(key) || !Object.hasOwn(r, key) || !finite(value) || value < 0,
        ))
    )
      fail('INVALID_INPUT', 'tolerances 只能为已请求的数值字段指定有限非负绝对公差。');
  }

  const stat = await fs.lstat(input.path);
  if (!stat.isFile() || stat.isSymbolicLink())
    fail('INVALID_FILE', '必须指定普通文件，不能是目录或符号链接。');
  if (stat.size > 32 * 1024 * 1024) fail('FILE_TOO_LARGE', 'SAM/SMP 超过 32 MiB 解析上限。');
  const handle = await fs.open(input.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size !== stat.size ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev
    )
      fail('FILE_CHANGED', '文件在打开前发生变化。');
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== bytes.length || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      fail('FILE_CHANGED', '文件在读取过程中发生变化。');
  } finally {
    await handle.close();
  }

  let status = null,
    format,
    text;
  const first = bytes
    .toString('utf8', 0, Math.min(bytes.length, 128))
    .replace(/^\ufeff/, '')
    .trimStart();
  if (first.startsWith('{')) {
    format = 'utf8-json';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('INVALID_ENCODING', '纯文本模板不是有效 UTF-8。');
    }
  } else {
    if (bytes.length < 8) fail('INVALID_HEADER', '文件不足 8 字节。');
    if (bytes.subarray(0, 5).toString('ascii') === '^vMIC')
      fail('UNSUPPORTED_FORMAT', '这是其他厂家 SMP 格式，不是本文支持的 Qt 样品文件。');
    const size = bytes.readUInt32BE(4);
    if (size === 0xffffffff) fail('EMPTY_TEMPLATE', '模板 QString 为 null。');
    if (size % 2 || size !== bytes.length - 8)
      fail('INVALID_HEADER', 'Qt 字符串字节长度与文件大小不匹配。');
    status = bytes.readInt32BE(0);
    format = 'qt-utf16be-json';
    try {
      text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(8));
    } catch {
      fail('INVALID_ENCODING', 'QString 不是有效 UTF-16BE。');
    }
  }
  let root;
  try {
    root = JSON.parse(text, (_key, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error();
      return value;
    });
  } catch {
    fail('INVALID_JSON', '模板内部 JSON 无效或包含非有限数值。');
  }
  if (!object(root)) fail('INVALID_JSON', 'JSON 根节点必须为对象。');
  const conditions = root['analysis conditions'];
  if (!object(conditions) || !object(conditions['isotherm collection']))
    fail('NOT_SAMPLE_TEMPLATE', '缺少样品实验条件；报告配置、吸附质或空管参数不是完整样品模板。');
  const collection = conditions['isotherm collection'];
  const gas = object(conditions['adsorptive properties'])
    ? conditions['adsorptive properties']
    : {};
  const thermal = object(conditions['p0 and temperature options'])
    ? conditions['p0 and temperature options']
    : {};
  const free = object(conditions['free space options']) ? conditions['free space options'] : {};
  const mass = object(root.mass) ? root.mass : {};
  const options = object(collection.options) ? collection.options : {};
  const warnings = [
    {
      code: 'VERSION_NOT_VERIFIED',
      message: '枚举依据2026-10-27格式文档当前定义；未验证此文件软件版本的实际读入与执行行为。',
    },
  ];
  const warn = (code, message) => {
    if (!warnings.some((w) => w.code === code)) warnings.push({ code, message });
  };
  const states = {
    0x10: 'new',
    0x20: 'analysing',
    0x40: 'completed',
    0x80: 'interrupted',
    0x100: 'imported',
    0x200: 'adsorptive-parameters',
    0x400: 'tube-parameters',
  };
  const family =
    status !== null && Object.hasOwn(states, status - 0x1000)
      ? 'g5'
      : status !== null && Object.hasOwn(states, status - 0x2000)
        ? 'g12'
        : null;
  const state = family ? states[status - (family === 'g5' ? 0x1000 : 0x2000)] : 'unknown';
  const mismatchedProduct = family && input.product !== 's60pro' && family !== input.product;
  if (mismatchedProduct)
    warn('PRODUCT_STATUS_MISMATCH', '所选产品与文件状态家族不一致，产品相关枚举不作归一化。');
  if (state !== 'new')
    warn(
      'NOT_NEW_TEMPLATE',
      '文件不是已确认的新建实验状态；解析或参数匹配不代表可直接提交为新任务。',
    );
  if (status !== null && root.analysisStatus !== undefined && root.analysisStatus !== status)
    warn('STATUS_MISMATCH', '文件头状态与 analysisStatus 不一致。');
  if (['adsorptive-parameters', 'tube-parameters'].includes(state))
    fail('NOT_SAMPLE_TEMPLATE', '参数模板不是普通样品实验模板。');
  const product = mismatchedProduct ? null : input.product;
  const typeMaps = {
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
  const freeMaps = {
    g5: { 0: 'measured', 1: 'manual', 2: 'calculated' },
    g12: { 0: 'measured', 1: 'post-calibration', 2: 'manual', 3: 'calculated' },
  };
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
  const scale =
    mode === 'relative-pp0'
      ? 1
      : mode === 'absolute-mmHg' && ['g5', 'g12'].includes(product)
        ? 1000
        : null;
  const pressure = (value) => (finite(value) && scale !== null ? value * scale : null);
  const base = ['analysis conditions', 'isotherm collection'];
  const facts = {};
  const fact = (name, value, source, unit) => {
    let raw = root,
      present = true;
    for (const key of source) {
      if (!object(raw) || !Object.hasOwn(raw, key)) {
        present = false;
        break;
      }
      raw = raw[key];
    }
    facts[name] = {
      value: value ?? null,
      source,
      presence: !present ? 'missing' : raw === null ? 'null' : 'value',
      ...(present && (raw === null || ['string', 'number', 'boolean'].includes(typeof raw))
        ? { rawValue: raw }
        : {}),
      ...(unit ? { unit } : {}),
    };
  };
  fact('softwareVersion', typeof root.softwareVersion === 'string' ? root.softwareVersion : null, [
    'softwareVersion',
  ]);
  fact('clientVersion', typeof root.clientVersion === 'string' ? root.clientVersion : null, [
    'clientVersion',
  ]);
  fact(
    'analysisType',
    Number.isInteger(conditions['analysis type'])
      ? (typeMaps[product]?.[conditions['analysis type']] ?? null)
      : null,
    ['analysis conditions', 'analysis type'],
  );
  fact('gasMnemonic', typeof gas.mnemonic === 'string' ? gas.mnemonic : null, [
    'analysis conditions',
    'adsorptive properties',
    'mnemonic',
  ]);
  fact(
    'temperatureK',
    finite(thermal.temperature) ? thermal.temperature + 273.15 : null,
    ['analysis conditions', 'p0 and temperature options', 'temperature'],
    'K (source: °C)',
  );
  fact(
    'p0MmHg',
    finite(thermal.p0) ? thermal.p0 : null,
    ['analysis conditions', 'p0 and temperature options', 'p0'],
    'mmHg',
  );
  fact(
    'maximumManifoldPressureMmHg',
    finite(gas['maximum manifold pressure']) ? gas['maximum manifold pressure'] : null,
    ['analysis conditions', 'adsorptive properties', 'maximum manifold pressure'],
    'mmHg',
  );
  fact(
    'absolutePressureToleranceMmHg',
    finite(options['absolute pressure tolerance']) ? options['absolute pressure tolerance'] : null,
    [...base, 'options', 'absolute pressure tolerance'],
    'mmHg',
  );
  fact(
    'sampleMassG',
    finite(mass['sample mass']) ? mass['sample mass'] : null,
    ['mass', 'sample mass'],
    'g',
  );
  fact(
    'tubeMassG',
    finite(mass['tube mass']) ? mass['tube mass'] : null,
    ['mass', 'tube mass'],
    'g',
  );
  fact('pressureMode', mode, [...base, 'absolute pressure dosing']);
  fact('collectionMode', acquisition, [...base, 'use target pressure']);
  fact(
    'freeSpaceMode',
    Number.isInteger(free['free space option type'])
      ? (freeMaps[product]?.[free['free space option type']] ?? null)
      : null,
    ['analysis conditions', 'free space options', 'free space option type'],
  );
  const prefix =
    acquisition === 'target-pressure' ? 'T_' : acquisition === 'dose-increment' ? 'D_' : null;
  fact(
    'lowPressureEnabled',
    prefix && typeof options[prefix + 'LPressIncrementalDoseMode'] === 'boolean'
      ? options[prefix + 'LPressIncrementalDoseMode']
      : null,
    [...base, 'options', prefix ? prefix + 'LPressIncrementalDoseMode' : '(mode unknown)'],
  );
  for (const [name, key, unit] of [
    ['lowPressureDoseCm3StpPerG', 'DoseAmount', 'cm³(STP)/g'],
    ['lowPressureMinHours', 'MinEquilibrationDelay', 'h'],
    ['lowPressureMaxHours', 'MaxEquilibrationDelay', 'h'],
  ])
    fact(
      name,
      prefix && facts.lowPressureEnabled.value === true && finite(options[prefix + key])
        ? options[prefix + key]
        : null,
      [...base, 'options', prefix ? prefix + key : '(mode unknown)'],
      unit,
    );

  function segments(value, kind) {
    if (value === undefined || value === null) return value ?? null;
    if (!Array.isArray(value) || value.length > 256)
      fail('INVALID_SEGMENTS', '压力/注气表必须为 null 或至多 256 项的数组。');
    return value.map((row, index) => {
      if (!object(row)) fail('INVALID_SEGMENTS', '压力/注气表中的每段必须为对象。');
      const valid =
        kind === 'pressures'
          ? ['start_p', 'end_p', 'increment_p', 'interval']
          : ['end_p', 'dose increment', 'percent of previous', 'interval'];
      const extraKeys = Object.keys(row).filter(
        (k) => ![...valid, 'use dose increment'].includes(k),
      );
      if (extraKeys.length)
        warn(
          'UNINTERPRETED_SEGMENT_FIELDS',
          '分段表含未解释的扩展字段，摘要不能证明完整执行行为已匹配。',
        );
      return {
        index,
        raw: Object.fromEntries(valid.filter((k) => Object.hasOwn(row, k)).map((k) => [k, row[k]])),
        ...(kind === 'pressures'
          ? {
              start: pressure(row.start_p),
              end: pressure(row.end_p),
              step: pressure(row.increment_p),
              intervalSeconds: finite(row.interval) ? row.interval : null,
              direction:
                finite(row.start_p) && finite(row.end_p)
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
  }
  const pressures = segments(collection.pressures, 'pressures');
  const increments = segments(collection.increments, 'increments');
  if (Object.values(facts).some((f) => f.value === null))
    warn('UNRESOLVED_FIELDS', '部分字段缺失、未启用或不在所选产品的已说明枚举内；不补默认值。');
  if (
    root.started ||
    root.completed ||
    ['analysis data', 'dropDatas', 'labData'].some((k) => root[k] && Object.keys(root[k]).length)
  )
    warn('HISTORICAL_DATA', '文件含运行时间或历史结果；不能把历史实验直接当成新建底稿。');
  if (mode === 'absolute-mmHg' && scale === null)
    warn('UNKNOWN_PRESSURE_SCALE', '所选产品的绝对压力倍率未确认，保留原值，不作倍率转换。');
  if (Array.isArray(root.reports) && root.reports.length > 64)
    fail('OUTPUT_TOO_LARGE', '报告配置超过 64 项，未输出截断内容。');

  let comparison;
  if (command === 'compare') {
    const equal = (a, b, tolerance = 0) =>
      typeof a === 'number' && typeof b === 'number'
        ? Math.abs(a - b) <= tolerance + Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 8
        : a === b;
    const checks = Object.entries(input.requirements).map(([field, expected]) => {
      let actual = facts[field]?.value ?? null;
      let reason;
      let unsupported =
        field === 'freeSpaceMode' && expected === 'post-calibration' && product === 'g5';
      if (unsupported) reason = 'G5 当前定义没有独立后标定枚举，不能套用 G12 的值。';
      if (field === 'pressureProgram') {
        actual =
          acquisition === 'target-pressure' && mode === input.requirements.pressureMode && pressures
            ? pressures.map(({ start, end, step, intervalSeconds }) => ({
                start,
                end,
                step,
                intervalSeconds,
              }))
            : null;
        if (actual?.some((row) => Object.values(row).some((v) => v === null))) actual = null;
        if (!actual) reason = '压力表未启用、压力模式不一致或存在无法解释的字段。';
      }
      const matches =
        field === 'pressureProgram' && actual
          ? actual.length === expected.length &&
            actual.every((row, i) =>
              Object.entries(row).every(([k, v]) => equal(v, expected[i][k])),
            )
          : equal(actual, expected, input.tolerances?.[field] ?? 0);
      return {
        field,
        expected,
        actual,
        status: unsupported
          ? 'unsupported'
          : actual === null
            ? 'unknown'
            : matches
              ? 'match'
              : 'mismatch',
        ...(reason ? { reason } : {}),
        ...(facts[field] ? { source: facts[field].source } : { source: [...base, 'pressures'] }),
      };
    });
    comparison = {
      overall: checks.some((c) => c.status === 'mismatch')
        ? 'mismatch'
        : checks.some((c) => c.status !== 'match')
          ? 'unknown'
          : 'match',
      checks,
    };
  }
  const summary = {
    backend: 'sam-file-inspection',
    operation: command,
    executionVerified: false,
    file: {
      path: input.path,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      format,
    },
    interpretation: {
      product: input.product,
      basis: 'SAM/SMP字段说明2026-10-27',
      versionVerified: false,
    },
    status: { raw: status, family, state, analysisStatus: root.analysisStatus ?? null },
    identity: {
      sampleName: root['sample name'] ?? null,
      uuid: typeof root.uuid === 'string' ? root.uuid : null,
      unit: root.unit ?? null,
      port: root.port ?? null,
    },
    facts,
    pressureProgram: {
      presence: !Object.hasOwn(collection, 'pressures')
        ? 'missing'
        : collection.pressures === null
          ? 'null'
          : 'value',
      active: acquisition === null ? null : acquisition === 'target-pressure',
      unit: scale === null ? null : mode === 'absolute-mmHg' ? 'mmHg' : 'P/P0',
      segments: pressures,
    },
    incrementProgram: {
      presence: !Object.hasOwn(collection, 'increments')
        ? 'missing'
        : collection.increments === null
          ? 'null'
          : 'value',
      active: acquisition === null ? null : acquisition === 'dose-increment',
      doseUnit: 'cm³(STP)/g',
      timeUnit: 's',
      segments: increments,
    },
    reports: Array.isArray(root.reports)
      ? root.reports.map((r) => ({
          type: r?.type ?? null,
          name: r?.options?.name ?? null,
          selected: typeof r?.options?.selected === 'boolean' ? r.options.selected : null,
        }))
      : null,
    warnings,
    ...(comparison ? { comparison } : {}),
  };
  const output = JSON.stringify(summary);
  if (Buffer.byteLength(output) > 60000)
    fail('OUTPUT_TOO_LARGE', '配置摘要超过输出上限，未输出截断内容。');
  return summary;
}
