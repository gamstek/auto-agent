import { win32 } from 'node:path';
import { AppError } from '../../shared/types';
import type { Evidence } from './schema';

export const referenceSections = [
  'overview',
  'sample',
  'gas',
  'temperature',
  'collection',
  'preparation',
  'freeSpace',
  'backfill',
  'tube',
  'corrections',
  'reports',
] as const;
export type ReferenceSection = (typeof referenceSections)[number];
type Path = (string | number)[];
type Scope = 'setting' | 'sample-context' | 'device-context' | 'uninterpreted';
export interface ReferenceField {
  presence: 'missing' | 'null' | 'value';
  value: unknown;
  scope: Scope;
  active?: boolean | null;
  unit?: string | null;
  normalized?: { value: unknown; unit?: string };
  source?: Path;
  transformation?: 'file-reference-only';
  label?: string;
}
export interface ReferenceGroup {
  source: Path;
  fields: Record<string, ReferenceField>;
  uninterpretedKeys: string[];
}
export interface ReferenceReport {
  type: number | null;
  optionsType: number | null;
  name: string | null;
  selected: boolean | null;
  source: Path;
  parameters: Record<string, ReferenceField>;
  uninterpretedKeys: string[];
}
export interface ReferenceSettings {
  revision: 'reference-settings-v1';
  groups: Record<string, ReferenceGroup>;
  reports: ReferenceReport[];
  issues: string[];
}
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const lookup = (root: any, path: Path): { present: boolean; value: any } => {
  for (const key of path) {
    if (!object(root) && !Array.isArray(root)) return { present: false, value: null };
    if (!Object.hasOwn(root, key)) return { present: false, value: null };
    root = (root as Record<string, any>)[String(key)];
  }
  return { present: true, value: root };
};
function bounded(value: unknown, depth = 0): unknown {
  if (depth > 8 || (typeof value === 'string' && value.length > 8192))
    throw new AppError('wiki_reference_limit', 'Reference parameter exceeds structural limits');
  if (Array.isArray(value)) {
    if (value.length > 256)
      throw new AppError('wiki_reference_limit', 'Reference table exceeds 256 rows');
    return value.map((item) => bounded(item, depth + 1));
  }
  if (object(value)) {
    if (Object.keys(value).length > 128)
      throw new AppError('wiki_reference_limit', 'Reference object exceeds 128 fields');
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, bounded(item, depth + 1)]),
    );
  }
  return value;
}
// Reference filenames are identifiers, not executable paths or bundled assets.
function fileReference(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!value) return '';
    let name = value;
    if (/^[a-z]+:\/\//i.test(name)) {
      try {
        name = new URL(name).pathname;
      } catch {
        return '[unresolved file reference]';
      }
    }
    return win32.basename(name.replaceAll('/', '\\'));
  }
  if (Array.isArray(value)) return value.map(fileReference);
  if (object(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'sampleName')
        .map(([key, item]) => [
          key,
          /filePathName|referenceFile|fluid properties file|^model$/i.test(key) ||
          (item !== null && typeof item === 'object')
            ? fileReference(item)
            : bounded(item),
        ]),
    );
  return value;
}

const gasFields = [
  'analysis conditions',
  'id',
  'gas type',
  'name',
  'mnemonic',
  'fluid properties file',
  'non-condensing adsorptive',
  'maximum manifold pressure',
  'dosing method',
  'charge from inlet',
  'purify adsorptive',
  'ideal gas law with non-ideality correction',
  'high resolution fluid',
  'non corrected mode',
  'adsorbed-phase free-space correction',
  'Psat vs Temperature Table',
  'vapor source temperature',
  'therm tran hard sphere diameter',
  'molecular cross sectional area',
  'adsorbate molecular weight',
  'diameter',
  'diameterAtZeroEnergy',
  'polarizability',
  'magneticSusceptibility',
  'density',
  'non-ideality factor',
  'density conversion factor',
  'affinity coefficient',
  'adsorbate property factor ads',
  'adsorbate property factor des',
];
const collectionOptions = [
  'first dose isActive',
  'first pressure fixed dose',
  'maximum increment isActive',
  'maximum volume increment',
  'absolute pressure tolerance',
  'relative pressure tolerance',
  ...['T_', 'D_'].flatMap((prefix) =>
    [
      'LPressIncrementalDoseMode',
      'DoseAmount',
      'MinEquilibrationDelay',
      'MaxEquilibrationDelay',
    ].map((key) => prefix + key),
  ),
];
const summaryMetrics = [
  'showAdsorptionTotalPoreVolume',
  'showDesorptionTotalPoreVolume',
  'showAveragePoreDiameter',
  'showMultiPointBET',
  'showSinglePointBET',
  'showLangmuir',
  'showt_PlotExternal',
  'showt_PlotMicroporeArea',
  'showt_PlotMicroporeVolume',
  'showBJHAdsorptionAveragePore',
  'showBJHDesorptionAveragePore',
  'showBJHAdsorptionMostProbablePoreWidth',
  'showBJHDesorptionMostProbablePoreWidth',
  'showBJHCumulativeAdsorptionArea',
  'showBJHCumulativeAdsorptionVolume',
  'showBJHCumulativeDesorptionArea',
  'showBJHCumulativeDesorptionVolume',
  'showDALimitingMicroporeVolume',
  'showDAMicroporeSurfaceArea',
  'showDRMicroporeSurfaceArea',
  'showDRMonolayerCapacity',
  'showHKMaximumPoreVolume',
  'showHKMedianPoreWidth',
  'showNLDFTPoreSize',
  'showNLDFTPoreVolumePercentage',
];
const thickness = [
  'thicknessFunc',
  'bdb',
  'carbonBlack',
  'halsey',
  'hj',
  'hAj',
  'kjs',
  'reference',
  'referenceFile',
];
const reportFields: Record<number, string[]> = {
  1: ['adsorptionPoresAtPP0', 'desorptionPoresAtPP0', ...summaryMetrics],
  5: [
    'selectPerGram',
    'selectPerBetSurfaceArea',
    'selectPerOtherSurfaceArea',
    'perOtherSurfaceArea',
    'adsCalThresholdValue',
    'desCalThresholdValue',
    'surfaceAreaCalThresholdValue',
    'summaryType',
  ],
  6: [
    'BETSmartPointSelection',
    'fitRange',
    'fitRangeSmart',
    'isothermRange',
    'isothermRangeSmart',
    'ErrorLimit',
    'MinNumOfPoints',
    'MinSquaredR',
    ...[1, 2, 3, 4, 5].map((i) => `RouquerolCriterion${i}`),
  ],
  7: ['fitRange', 'isothermRange'],
  10: [
    ...thickness,
    'thicknessRange',
    'isothermRange',
    'enteredSurfaceArea',
    'surfaceAreaCorrectionFactor',
  ],
  13: [
    ...thickness,
    'BJHCorrection',
    'adsorptiveOptions',
    'collectedPoints',
    'cumulativeReports',
    'fixedPoints',
    'fractionOfPoresOpenAtBothEnds',
    'isothermRange',
    'poreWidthRange',
    'smoothDifferentials',
  ],
  14: [
    ...thickness,
    'BJHCorrection',
    'adsorptiveOptions',
    'collectedPoints',
    'cumulativeReports',
    'fixedPoints',
    'isothermRange',
    'poreWidthRange',
    'smoothDifferentials',
  ],
  17: [
    'adsorbentList',
    'adsorptiveList',
    'currentAdsorbent',
    'currentAdsorptive',
    'poreGeometry',
    'isothermRange',
    'applyChengYangCorrection',
    'computed',
    'enteredInteractionParameter',
    'smoothDifferentials',
  ],
  18: [
    'selectedFile',
    'geometry',
    'geometry_model_array',
    'isothermRange',
    'useVersion2Deconvolution',
    'userRegularization',
  ],
  21: [
    'adsorptiveOptions',
    'astakhovSelected',
    'radushkevichSelected',
    'fitRange_da',
    'fitRange_dr',
    'isothermRange',
    'exponent',
    'optimizeExponent',
  ],
};
const reportCandidates: Record<number, string[]> = {
  5: [
    'P0',
    'temperature',
    'sampleMass',
    'freeSpaceType',
    'enteredAmbientSpace',
    'enteredAnalysisSpace',
    'nonIdealityFactor',
    'pressureType',
    'chooseOption',
    'Psat vs Temperature Table',
  ],
  18: ['curRegularization', 'poreVolumes'],
  26: ['calibrationVolume'],
};
const reportCaches = new Set([
  'result',
  'surfaceArea',
  'min_i',
  'min_j',
  'bet_areas',
  'error_vector_2d',
  'valid_bet_areas',
  'valid_indices',
  'valid_knee_bet_areas',
  'valid_knee_indices',
  'valid_knee_pc_errors',
  'valid_pc_errors',
  'excludes',
  'information',
  'warnings',
  'has_valid_areas',
  'optRMSError',
  'optRegularization',
  'optRoughness',
  'excludedPointUuids',
  'computedInteractionParameter',
  'selectedIndex_min',
  'selectedIndex_max',
  'adsMatchIndex',
  'desMatchIndex',
  'surfaceAreaMatchIndex',
  'singlePointSurfaceArea',
  'excludeList',
  'excludeTable',
  'excludePP0List',
  'errCode',
]);

export function extractReference(
  root: Record<string, any>,
  product?: 'g5' | 'g12',
): ReferenceSettings {
  const groups: Record<string, ReferenceGroup> = {};
  const make = (name: string, source: Path, keys: string[], scope: Scope = 'setting') => {
    const group: ReferenceGroup = { source, fields: {}, uninterpretedKeys: [] };
    const container = lookup(root, source).value;
    for (const key of keys) {
      const item = lookup(root, [...source, key]);
      group.fields[key] = {
        presence: !item.present ? 'missing' : item.value === null ? 'null' : 'value',
        value: item.present ? bounded(item.value) : null,
        scope,
      };
    }
    if (object(container))
      group.uninterpretedKeys = Object.keys(container).filter((key) => !keys.includes(key));
    groups[name] = group;
    return group;
  };
  const units = (group: ReferenceGroup, values: Record<string, string>) => {
    for (const [key, unit] of Object.entries(values))
      if (group.fields[key]) group.fields[key]!.unit = unit;
  };
  const mode = make('overview', [], ['labType', 'manuallyImport']);
  const lab = mode.fields.labType!;
  if ([0, 1].includes(lab.value as number))
    lab.normalized = { value: lab.value === 0 ? 'regular' : 'high-throughput' };
  const sample = make(
    'sample',
    ['mass'],
    ['sample mass', 'tube mass', 'density', 'isEnter'],
    'sample-context',
  );
  units(sample, { 'sample mass': 'g', 'tube mass': 'g', density: 'g/cm³' });
  const pretreatment: ReferenceGroup = {
    source: ['base infos'],
    fields: {},
    uninterpretedKeys: [],
  };
  if (Array.isArray(root['base infos']))
    for (const [i, entry] of root['base infos'].entries()) {
      if (
        !object(entry) ||
        typeof entry.title !== 'string' ||
        !['pretreatment', '处理条件', '预处理条件', '预处理'].includes(
          entry.title.trim().toLowerCase(),
        )
      )
        continue;
      pretreatment.fields[String(i)] = {
        presence: Object.hasOwn(entry, 'value')
          ? entry.value === null
            ? 'null'
            : 'value'
          : 'missing',
        value: Object.hasOwn(entry, 'value') ? bounded(entry.value) : null,
        label: entry.title,
        source: ['base infos', i, 'value'],
        scope: 'sample-context',
      };
    }
  groups.pretreatment = pretreatment;
  const base = ['analysis conditions'];
  const gas = make('gas', [...base, 'adsorptive properties'], gasFields);
  units(gas, { 'maximum manifold pressure': 'mmHg' });
  if (typeof gas.fields['fluid properties file']!.value === 'string') {
    gas.fields['fluid properties file']!.value = fileReference(
      gas.fields['fluid properties file']!.value,
    );
    gas.fields['fluid properties file']!.transformation = 'file-reference-only';
  }
  const temperature = make(
    'temperature',
    [...base, 'p0 and temperature options'],
    [
      'choose one option',
      'p0',
      'temperature',
      'p0 and temp adsorptive id',
      'p0 and temp adsorptive name',
      'p0 and temp adsorptive mnemonic',
      'p0 and temp dose gas',
      'Psat vs Temperature Table',
    ],
  );
  units(temperature, { p0: 'mmHg', temperature: '°C' });
  if (typeof temperature.fields.temperature!.value === 'number')
    temperature.fields.temperature!.normalized = {
      value: temperature.fields.temperature!.value + 273.15,
      unit: 'K',
    };
  const collection = make(
    'collection',
    [...base, 'isotherm collection'],
    [
      'use target pressure',
      'absolute pressure dosing',
      'minimum equilibration delay at p/p0 >= 0.995',
      'advanced mode',
    ],
  );
  collection.fields['advanced mode']!.scope = 'uninterpreted';
  const active = collection.fields['use target pressure']!.value;
  const charge = lookup(root, ['analysis conditions', 'charge template']);
  collection.fields['charge template'] = {
    presence: !charge.present ? 'missing' : charge.value === null ? 'null' : 'value',
    value: charge.present ? bounded(charge.value) : null,
    scope: 'setting',
    source: ['analysis conditions', 'charge template'],
  };
  for (const key of collectionOptions) {
    const item = lookup(root, [...collection.source, 'options', key]);
    collection.fields[key] = {
      presence: !item.present ? 'missing' : item.value === null ? 'null' : 'value',
      value: item.present ? bounded(item.value) : null,
      scope: 'setting',
      source: [...collection.source, 'options', key],
      ...(key.startsWith('T_') || key.startsWith('D_')
        ? { active: typeof active === 'boolean' ? key.startsWith('T_') === active : null }
        : {}),
    };
  }
  for (const prefix of ['T_', 'D_'])
    for (const suffix of ['DoseAmount', 'MinEquilibrationDelay', 'MaxEquilibrationDelay']) {
      const field = collection.fields[prefix + suffix]!;
      const enabled = collection.fields[prefix + 'LPressIncrementalDoseMode']!.value;
      if (field.active === true) field.active = typeof enabled === 'boolean' ? enabled : null;
    }
  for (const [key, flag] of [
    ['first pressure fixed dose', 'first dose isActive'],
    ['maximum volume increment', 'maximum increment isActive'],
  ]) {
    const enabled = collection.fields[flag!]!.value;
    collection.fields[key!]!.active = typeof enabled === 'boolean' ? enabled : null;
  }
  units(collection, {
    'minimum equilibration delay at p/p0 >= 0.995': 's',
    'first pressure fixed dose': 'cm³(STP)/g',
    'maximum volume increment': 'cm³(STP)/g',
    'absolute pressure tolerance': 'mmHg',
    'relative pressure tolerance': '%',
    T_DoseAmount: 'cm³(STP)/g',
    D_DoseAmount: 'cm³(STP)/g',
    T_MinEquilibrationDelay: 'h',
    T_MaxEquilibrationDelay: 'h',
    D_MinEquilibrationDelay: 'h',
    D_MaxEquilibrationDelay: 'h',
  });
  collection.uninterpretedKeys = collection.uninterpretedKeys.filter(
    (key) => !['pressures', 'increments', 'options'].includes(key),
  );
  const options = lookup(root, [...collection.source, 'options']).value;
  if (object(options))
    collection.uninterpretedKeys.push(
      ...Object.keys(options)
        .filter((key) => !collectionOptions.includes(key))
        .map((key) => `options.${key}`),
    );
  const increments = lookup(root, [...collection.source, 'increments']).value;
  if (Array.isArray(increments))
    for (const [index, row] of increments.entries())
      for (const key of ['dose target pressure', 'use fixed dose']) {
        if (object(row) && Object.hasOwn(row, key))
          collection.fields[`increments[${index}].${key}`] = {
            presence: row[key] === null ? 'null' : 'value',
            value: bounded(row[key]),
            source: [...collection.source, 'increments', index, key],
            scope: 'uninterpreted',
          };
      }
  const preparation = make(
    'preparation',
    [...base, 'preparation options'],
    [
      'fast evacuation',
      'evacuation rate',
      'unresticted evac. from',
      'evacuation time',
      'leak test',
      'leak test duration',
      'UseTranSeal',
      'VaccumSetPoint',
    ],
  );
  preparation.fields.VaccumSetPoint!.scope = 'uninterpreted';
  units(preparation, {
    'evacuation rate': 'mmHg/s',
    'unresticted evac. from': 'mmHg',
    'evacuation time': 'h',
    'leak test duration': 's',
  });
  preparation.fields['leak test duration']!.active =
    typeof preparation.fields['leak test']!.value === 'boolean'
      ? preparation.fields['leak test']!.value
      : null;
  const freeSpace = make(
    'freeSpace',
    [...base, 'free space options'],
    [
      'free space option type',
      'lower dewar for evacuation',
      'evacuation time',
      'outgas test',
      'outgas test duration',
      'ambient free space',
      'analysis free space',
      'enter ambient free space',
      'enter analysis free space',
      'ambient free space after',
      'analysis free space after',
      'evacuation time after',
    ],
  );
  units(freeSpace, {
    'evacuation time': 'h',
    'outgas test duration': 's',
    'ambient free space': 'cm³',
    'analysis free space': 'cm³',
    'enter ambient free space': 'cm³',
    'enter analysis free space': 'cm³',
    'ambient free space after': 'cm³',
    'analysis free space after': 'cm³',
  });
  const freeMode = freeSpace.fields['free space option type']!.value;
  const knownMode =
    typeof freeMode === 'number' &&
    (product === 'g5'
      ? [0, 1, 2].includes(freeMode)
      : product === 'g12'
        ? [0, 1, 2, 3].includes(freeMode)
        : false);
  for (const key of ['enter ambient free space', 'enter analysis free space']) {
    freeSpace.fields[key]!.active = knownMode ? freeMode === (product === 'g5' ? 1 : 2) : null;
    freeSpace.fields[key]!.scope = 'sample-context';
  }
  for (const key of [
    'ambient free space after',
    'analysis free space after',
    'evacuation time after',
  ])
    freeSpace.fields[key]!.active = knownMode ? product === 'g12' && freeMode === 1 : null;
  freeSpace.fields['outgas test duration']!.active =
    typeof freeSpace.fields['outgas test']!.value === 'boolean'
      ? freeSpace.fields['outgas test']!.value
      : null;
  for (const key of [
    'ambient free space',
    'analysis free space',
    'ambient free space after',
    'analysis free space after',
  ])
    freeSpace.fields[key]!.scope = 'sample-context';
  freeSpace.fields['evacuation time after']!.scope = 'uninterpreted';
  const backfill = make(
    'backfill',
    [...base, 'sample backfill options'],
    ['backfill sample at start of analysis', 'backfill sample at end of analysis', 'backfill gas'],
  );
  const startBackfill = backfill.fields['backfill sample at start of analysis']!.value;
  const endBackfill = backfill.fields['backfill sample at end of analysis']!.value;
  backfill.fields['backfill gas']!.active =
    startBackfill === true || endBackfill === true
      ? true
      : startBackfill === false && endBackfill === false
        ? false
        : null;
  const tube = make(
    'tube',
    ['sample tube'],
    [
      'name',
      'use isothermal jacket',
      'use filter rod',
      'use air isolation plug',
      'ambient free space',
      'analysis free space',
      'non-ideality factor',
    ],
  );
  units(tube, { 'ambient free space': 'cm³', 'analysis free space': 'cm³' });
  for (const key of ['ambient free space', 'analysis free space', 'non-ideality factor'])
    tube.fields[key]!.scope = 'device-context';
  const corrections = make(
    'corrections',
    [],
    [
      'thermalCorrection',
      'enableNoiseRejection',
      'enableReferenceTube',
      'leakRateCorrectMode',
      'originalVolume',
      'systemVolume',
      'upperVolume',
      'lowerVolume',
      'leakRate',
      'firmwareVersion',
    ],
  );
  for (const key of [
    'originalVolume',
    'systemVolume',
    'upperVolume',
    'lowerVolume',
    'leakRate',
    'firmwareVersion',
  ])
    corrections.fields[key]!.scope = 'device-context';
  mode.uninterpretedKeys = [];
  corrections.uninterpretedKeys = [];
  const reports: ReferenceReport[] = (Array.isArray(root.reports) ? root.reports : []).map(
    (report: any, index: number) => {
      const type = Number.isInteger(report?.type) ? report.type : null;
      const options = object(report?.options) ? report.options : {};
      const selected = typeof options.selected === 'boolean' ? options.selected : null;
      const optionsType = Number.isInteger(options.type) ? options.type : null;
      const parameters: Record<string, ReferenceField> = {};
      for (const key of [...(reportFields[type] ?? []), ...(reportCandidates[type] ?? [])]) {
        const present = Object.hasOwn(options, key);
        const field: ReferenceField = {
          presence: !present ? 'missing' : options[key] === null ? 'null' : 'value',
          value: present ? bounded(options[key]) : null,
          scope:
            reportCandidates[type]?.includes(key) || optionsType !== type
              ? 'uninterpreted'
              : 'setting',
          active: selected,
        };
        if (['selectedFile', 'referenceFile', 'geometry_model_array'].includes(key)) {
          field.value = fileReference(field.value);
          field.transformation = 'file-reference-only';
        }
        parameters[key] = field;
      }
      return {
        type,
        optionsType,
        name: typeof options.name === 'string' ? options.name : null,
        selected,
        source: ['reports', index],
        parameters,
        uninterpretedKeys: Object.keys(options).filter(
          (key) =>
            !Object.hasOwn(parameters, key) &&
            !['type', 'name', 'selected'].includes(key) &&
            !reportCaches.has(key) &&
            !/plot|graph|^show|tabularColumns|poreTableColumns/i.test(key),
        ),
      };
    },
  );
  const issues: string[] = [];
  const gasId = gas.fields.id!.value,
    temperatureId = temperature.fields['p0 and temp adsorptive id']!.value;
  if (gasId !== null && temperatureId !== null && gasId !== temperatureId)
    issues.push(
      'GAS_LINK_MISMATCH: adsorptive and P0/temperature IDs differ; source values retained without correction.',
    );
  for (const report of reports) {
    if (report.optionsType !== report.type)
      issues.push(
        `REPORT_TYPE_MISMATCH: reports[${report.source[1]}] type and options.type differ; calculation fields remain uninterpreted.`,
      );
    if (report.selected && report.type === 18) {
      const selected = report.parameters.selectedFile?.value as Record<string, any> | null;
      const models = report.parameters.geometry_model_array?.value;
      if (
        !(typeof selected?.filePathName === 'string' && selected.filePathName) &&
        !(
          Array.isArray(models) &&
          models.some((entry) => object(entry) && typeof entry.model === 'string' && entry.model)
        )
      )
        issues.push(
          `MODEL_REFERENCE_UNRESOLVED: selected DFT report at reports[${report.source[1]}] has no supplied model/file identifier; model availability is unverified.`,
        );
    }
  }
  const result: ReferenceSettings = { revision: 'reference-settings-v1', groups, reports, issues };
  if (Buffer.byteLength(JSON.stringify(result)) > 192 * 1024)
    throw new AppError('wiki_reference_limit', 'Reference settings exceed 192 KiB');
  return result;
}

export function referenceEvidence(reference: ReferenceSettings): Evidence[] {
  const evidence: Evidence[] = [];
  const add = (section: ReferenceSection, key: string, field: ReferenceField, source: Path) => {
    if (field.presence === 'missing') return;
    const label =
      section === 'sample' && source[0] === 'base infos'
        ? `预处理 pretreatment ${field.label ?? ''}`
        : key;
    const text = `${label}: ${JSON.stringify(field.value)}`;
    evidence.push({
      kind: 'json-path',
      text: text.slice(0, 1000),
      path: source,
      section,
      scope: field.scope,
      ...(field.active !== undefined ? { active: field.active } : {}),
      ...(text.length > 1000 ? { truncated: true } : {}),
    });
  };
  for (const [name, group] of Object.entries(reference.groups))
    for (const [key, field] of Object.entries(group.fields)) {
      const path = field.source ?? [...group.source, key];
      add(name === 'pretreatment' ? 'sample' : (name as ReferenceSection), key, field, path);
    }
  for (const report of reference.reports) {
    add(
      'reports',
      report.name ?? String(report.type),
      {
        presence: 'value',
        value: { type: report.type, name: report.name, selected: report.selected },
        scope: 'setting',
        active: report.selected,
      },
      report.source,
    );
    for (const [key, field] of Object.entries(report.parameters))
      add('reports', `${report.name ?? report.type} ${key}`, field, [
        ...report.source,
        'options',
        key,
      ]);
  }
  return evidence;
}

export function projectConfiguration(
  configuration: Record<string, unknown>,
  sections: ReferenceSection[],
) {
  const result = Object.fromEntries(
    ['backend', 'operation', 'executionVerified', 'file', 'interpretation', 'status', 'identity']
      .filter((key) => Object.hasOwn(configuration, key))
      .map((key) => [key, configuration[key]]),
  );
  if (sections.includes('overview'))
    for (const key of ['facts', 'warnings', 'reports']) result[key] = configuration[key];
  if (sections.includes('collection'))
    for (const key of ['pressureProgram', 'incrementProgram']) result[key] = configuration[key];
  if (sections.includes('reports')) result.reports = configuration.reports;
  const reference = configuration.referenceSettings as ReferenceSettings | undefined;
  if (reference)
    result.referenceSettings = {
      revision: reference.revision,
      issues: reference.issues,
      groups: Object.fromEntries(
        Object.entries(reference.groups).filter(([key]) =>
          sections.includes(key === 'pretreatment' ? 'sample' : (key as ReferenceSection)),
        ),
      ),
      ...(sections.includes('reports') ? { reports: reference.reports } : {}),
    };
  return result;
}
