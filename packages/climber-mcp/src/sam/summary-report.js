// Native display-option keys, not material recommendations or template defaults.
export const SUMMARY_REPORT_FLAGS = [
  'showSinglePointBET',
  'showMultiPointBET',
  'showLangmuir',
  'showt_PlotMicroporeArea',
  'showt_PlotExternal',
  'showBJHCumulativeAdsorptionArea',
  'showBJHCumulativeDesorptionArea',
  'showAdsorptionTotalPoreVolume',
  'showDesorptionTotalPoreVolume',
  'showt_PlotMicroporeVolume',
  'showBJHCumulativeAdsorptionVolume',
  'showBJHCumulativeDesorptionVolume',
  'showAveragePoreDiameter',
  'showBJHAdsorptionAveragePore',
  'showBJHDesorptionAveragePore',
  'showBJHAdsorptionMostProbablePoreWidth',
  'showBJHDesorptionMostProbablePoreWidth',
  'showDAMicroporeSurfaceArea',
  'showDALimitingMicroporeVolume',
  'showHKMaximumPoreVolume',
  'showHKMedianPoreWidth',
  'showNLDFTPoreSize',
  'showNLDFTPoreVolumePercentage',
  'showDRMicroporeSurfaceArea',
  'showDRMonolayerCapacity',
  'showAbnormalDefOption1',
  'showAbnormalDefOption2',
  'showAbnormalDefOption3',
  'showAbnormalDefOption4',
];
const thresholds = ['adsorptionPoresAtPP0', 'desorptionPoresAtPP0'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validThreshold = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const fail = (message) => {
  throw Object.assign(new Error(message), {
    publicCode: 'INVALID_SUMMARY_REPORT',
    writeOutcome: 'not-started',
  });
};

export function validateSummaryReport(input, complete = false) {
  const keys = ['enabledFields', ...thresholds];
  if (
    !object(input) ||
    !Object.keys(input).length ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    fail('summaryReport 接受 enabledFields、adsorptionPoresAtPP0、desorptionPoresAtPP0。');
  if (complete && keys.some((key) => !Object.hasOwn(input, key)))
    fail(
      '新建且勾选概要报告时，须显式提供 summaryReport 的 enabledFields 和两个 P/P0 值，按所选文档模板填写。',
    );
  if (
    Object.hasOwn(input, 'enabledFields') &&
    (!Array.isArray(input.enabledFields) ||
      input.enabledFields.length > SUMMARY_REPORT_FLAGS.length ||
      new Set(input.enabledFields).size !== input.enabledFields.length ||
      input.enabledFields.some((key) => !SUMMARY_REPORT_FLAGS.includes(key)))
  )
    fail('enabledFields 必须是不重复的概要报告原生开关名称数组；可用字段见 SAM 写入参考文档。');
  if (thresholds.some((key) => Object.hasOwn(input, key) && !validThreshold(input[key])))
    fail('概要报告 P/P0 必须是 0–1 的有限数值。');
}

export function applySummaryReport(root, input, complete = false) {
  validateSummaryReport(input, complete);
  const reports = Array.isArray(root.reports)
    ? root.reports.filter((report) => report?.type === 1)
    : [];
  if (reports?.length !== 1 || !object(reports[0].options))
    fail('需要一项完整的概要报告（type=1），不能据字段名称拼造报告配置。');
  const options = reports[0].options;
  if (input.enabledFields !== undefined) {
    if (SUMMARY_REPORT_FLAGS.some((key) => typeof options[key] !== 'boolean'))
      fail('当前概要配置缺少已支持的布尔开关，请核对产品与版本的完整报告配置。');
    for (const key of SUMMARY_REPORT_FLAGS) options[key] = input.enabledFields.includes(key);
  }
  for (const key of thresholds) {
    if (!Object.hasOwn(input, key)) continue;
    if (!validThreshold(options[key])) fail(`概要配置缺少有效的 ${key}，请核对产品与版本。`);
    options[key] = input[key];
  }
}

export function readSummaryReport(root, product) {
  const reports = Array.isArray(root.reports) ? root.reports : [];
  const index = reports.findIndex((report) => report?.type === 1);
  const report = reports[index];
  const options = report?.options;
  const supported = ['g5', 'g12'].includes(product);
  const unique = reports.filter((entry) => entry?.type === 1).length === 1;
  const fields = [...SUMMARY_REPORT_FLAGS, ...thresholds];
  const raw = object(options)
    ? Object.fromEntries(
        fields.filter((key) => Object.hasOwn(options, key)).map((key) => [key, options[key]]),
      )
    : {};
  const unresolvedFields = fields.filter((key) =>
    SUMMARY_REPORT_FLAGS.includes(key) ? typeof raw[key] !== 'boolean' : !validThreshold(raw[key]),
  );
  return {
    presence: index < 0 || options === undefined ? 'missing' : options === null ? 'null' : 'value',
    supported: supported && unique && object(options),
    selected: typeof options?.selected === 'boolean' ? options.selected : null,
    options: raw,
    enabledFields:
      supported && unique && SUMMARY_REPORT_FLAGS.every((key) => typeof raw[key] === 'boolean')
        ? SUMMARY_REPORT_FLAGS.filter((key) => raw[key])
        : null,
    unresolvedFields,
    extraKeys: object(options)
      ? Object.keys(options).filter((key) => ![...fields, 'name', 'type', 'selected'].includes(key))
      : [],
    source: ['reports', index < 0 ? null : index, 'options'],
  };
}

export function compareSummaryReport(actual, expected) {
  return Object.entries(expected).map(([key, value]) => {
    const observed =
      key === 'enabledFields'
        ? actual.enabledFields
        : validThreshold(actual.options[key])
          ? actual.options[key]
          : null;
    const match =
      key === 'enabledFields'
        ? observed !== null &&
          observed.length === value.length &&
          value.every((field) => observed.includes(field))
        : observed === value;
    return {
      field: `summaryReport.${key}`,
      expected: value,
      actual: observed,
      status: !actual.supported
        ? 'unsupported'
        : observed === null
          ? 'unknown'
          : match
            ? 'match'
            : 'mismatch',
      source: key === 'enabledFields' ? actual.source : [...actual.source, key],
    };
  });
}
