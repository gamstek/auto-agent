import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

// Explicit offline import only. Runtime generation never depends on these source files.
const [root, bet, micro, meso, workingG5] = process.argv.slice(2);
if (!root || !bet || !micro || !meso || !workingG5)
  throw new Error(
    'Usage: bun scripts/import-sam-profiles.ts <root> <g5-bet> <g12-micropore> <g5-mesopore> <working-g5-template>',
  );
const inputs = await Promise.all(
  [bet, micro, meso, workingG5].map(async (name) => {
    const file = resolve(root, name);
    const label = relative(resolve(root), file).replaceAll('\\', '/');
    if (isAbsolute(label) || label.split('/').includes('..'))
      throw new Error('Source must be within root');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      throw new Error('Invalid source');
    const bytes = await readFile(file);
    if (bytes.length < 8 || bytes.readUInt32BE(4) !== bytes.length - 8)
      throw new Error('Invalid Qt framing');
    const template = JSON.parse(
      new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(8)),
    );
    return {
      template,
      origin: {
        path: label,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        status: bytes.readInt32BE(0),
      },
    };
  }),
);
const [b, m, e, working] = inputs;
if (
  b!.origin.status !== 0x1040 ||
  m!.origin.status !== 0x2010 ||
  e!.origin.status !== 0x1040 ||
  working!.origin.status !== 0x1010
)
  throw new Error(
    'Expected documented G5 BET/completed, G12 micropore/new, G5 mesopore/completed and executable G5/new sources',
  );
for (const [index, type] of [0, 10, 1, 1].entries())
  if (inputs[index]!.template['analysis conditions']['analysis type'] !== type)
    throw new Error('Method mismatch');
for (const { template, origin } of inputs) {
  const conditions = template['analysis conditions'];
  const gas = conditions['adsorptive properties'];
  const thermal = conditions['p0 and temperature options'];
  const collection = conditions['isotherm collection'];
  if (
    gas.mnemonic !== 'N2' ||
    gas['gas type'] !== 2 ||
    thermal['p0 and temp dose gas'] !== 2 ||
    thermal['p0 and temp adsorptive id'] !== gas.id ||
    collection['absolute pressure dosing'] !== false ||
    typeof collection['use target pressure'] !== 'boolean' ||
    !Array.isArray(collection.pressures) ||
    !collection.pressures.length ||
    collection.pressures.length > 256 ||
    !template.softwareVersion ||
    !template.clientVersion ||
    !Array.isArray(template.reports) ||
    !template.reports.length ||
    template.reports.length > 64 ||
    !template.reports.some(
      (report: { options?: { selected?: boolean } }) => report.options?.selected === true,
    ) ||
    template.reports.some(
      (report: { type?: unknown; options?: Record<string, unknown> }) =>
        !Number.isInteger(report.type) ||
        !report.options ||
        report.options.type !== report.type ||
        typeof report.options.selected !== 'boolean' ||
        typeof report.options.name !== 'string',
    )
  )
    throw new Error(
      `Expected complete, linked N2 properties and a relative target-pressure program: ${origin.path} (${JSON.stringify({ gas: gas.mnemonic, gasType: gas['gas type'], id: gas.id, p0Id: thermal['p0 and temp adsorptive id'], doseGas: thermal['p0 and temp dose gas'], absolute: collection['absolute pressure dosing'], target: collection['use target pressure'] })})`,
    );
}
// The supplied executable G5 file is the current schema authority. Historical
// method programs remain separately source-cited, never relabelled as its version.
const profiles = [working!, m!].map(({ template, origin }, index) => {
  const product = index === 0 ? 'g5' : 'g12';
  // Preserve the native configuration structure, including required empty fields
  // and version-specific report options; reset identities and historical results.
  const configuration = Object.fromEntries(
    [
      'softwareVersion',
      'clientVersion',
      'sample tube',
      'analysis conditions',
      'originalVolume',
      'thermalCorrection',
      'enableNoiseRejection',
      'enableReferenceTube',
      'systemVolume',
      'upperVolume',
      'lowerVolume',
      'leakRateCorrectMode',
      'leakRate',
      'historicalPdfComparison',
      'base infos',
      'review the reports after the test',
    ]
      .filter((key) => Object.hasOwn(template, key))
      .map((key) => [key, structuredClone(template[key])]),
  );
  const free = configuration['analysis conditions']['free space options'];
  const collection = configuration['analysis conditions']['isotherm collection'];
  delete collection['advanced mode'];
  if (Array.isArray(collection.increments))
    collection.increments = collection.increments.map((row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([key]) => !['dose target pressure', 'use fixed dose'].includes(key),
        ),
      ),
    );
  configuration.mass = { density: template.mass.density, isEnter: template.mass.isEnter };
  // Operator-confirmed current interface constraint, independent of source values.
  configuration.labType = 0;
  configuration['analysis data'] = null;
  configuration.dropDatas = null;
  configuration.labData = '';
  configuration.started = '';
  configuration.serialNO = '';
  configuration.firmwareVersion = '';
  if (Object.hasOwn(template, 'tubeCode')) configuration.tubeCode = '';
  if (Array.isArray(configuration['base infos']))
    configuration['base infos'] = configuration['base infos'].map(
      (entry: Record<string, unknown>) => ({ ...entry, value: '' }),
    );
  configuration.reports = template.reports.map(
    (report: { type: number; options: Record<string, unknown> }) => {
      const options = structuredClone(report.options);
      // These members store computed/cache state, not report configuration.
      for (const key of [
        'surfaceArea',
        'min_i',
        'min_j',
        'optRMSError',
        'optRegularization',
        'optRoughness',
      ])
        if (Object.hasOwn(options, key)) options[key] = 0;
      for (const key of [
        'bet_areas',
        'error_vector_2d',
        'valid_bet_areas',
        'valid_indices',
        'valid_knee_bet_areas',
        'valid_knee_indices',
        'valid_knee_pc_errors',
        'valid_pc_errors',
        'excludes',
      ])
        if (Object.hasOwn(options, key)) options[key] = null;
      for (const key of ['information', 'warnings'])
        if (Object.hasOwn(options, key)) options[key] = '';
      if (Object.hasOwn(options, 'has_valid_areas')) options.has_valid_areas = false;
      if (Array.isArray(options.excludedPointUuids)) options.excludedPointUuids = [];
      return { type: report.type, options };
    },
  );
  free['free space option type'] = 0; // measured, documented separately for both products
  for (const key of [
    'ambient free space',
    'analysis free space',
    'ambient free space after',
    'analysis free space after',
    'enter ambient free space',
    'enter analysis free space',
  ])
    if (Object.hasOwn(free, key)) free[key] = 0;
  return {
    id: `${product}-n2-${template.clientVersion}`,
    product,
    gas: 'N2',
    origin,
    sourceEvidence:
      index === 0
        ? { kind: 'operator-confirmed-executable-template', method: 'mesopore' }
        : { kind: 'historical-new-template', method: 'micropore' },
    normalization: [
      'new task identity/status',
      'empty acquisition fields',
      'empty hardware identity',
      'pending sample masses',
      'measured free space without historical values',
      'reset computed report caches',
      'operator-required labType=0',
    ],
    configuration,
  };
});
const programs = Object.fromEntries(
  ['bet', 'micropore', 'mesopore'].map((method, index) => {
    const { template, origin } = index === 2 ? working! : inputs[index]!;
    const collection = template['analysis conditions']['isotherm collection'];
    return [
      method,
      {
        origin,
        collection: {
          'absolute pressure dosing': collection['absolute pressure dosing'],
          'use target pressure': collection['use target pressure'],
          'minimum equilibration delay at p/p0 >= 0.995':
            collection['minimum equilibration delay at p/p0 >= 0.995'],
          pressures: collection.pressures,
          increments:
            collection.increments?.map((row: Record<string, unknown>) =>
              Object.fromEntries(
                Object.entries(row).filter(
                  ([key]) => !['dose target pressure', 'use fixed dose'].includes(key),
                ),
              ),
            ) ?? null,
          options: collection.options,
        },
      },
    ];
  }),
);
const output = resolve(
  import.meta.dir,
  '../skills/device-automation/scripts/lib/sam-profiles.json',
);
await writeFile(
  output,
  JSON.stringify({ revision: 'sam-profiles-v2', profiles, programs }, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    output,
    profiles: profiles.map(({ id }) => id),
    programs: Object.keys(programs),
  }),
);
