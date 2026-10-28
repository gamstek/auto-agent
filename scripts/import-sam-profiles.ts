import { readFile, writeFile, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

// Explicit offline import only. Runtime generation never depends on these source files.
const [root, bet, micro, meso] = process.argv.slice(2);
if (!root || !bet || !micro || !meso)
  throw new Error(
    'Usage: bun scripts/import-sam-profiles.ts <root> <g5-bet> <g12-micropore> <g5-mesopore>',
  );
const inputs = await Promise.all(
  [bet, micro, meso].map(async (name) => {
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
const [b, m, e] = inputs;
if (b!.origin.status !== 0x1040 || m!.origin.status !== 0x2010 || e!.origin.status !== 0x1040)
  throw new Error(
    'Expected documented G5 BET/completed, G12 micropore/new and G5 mesopore/completed sources',
  );
for (const [index, type] of [0, 10, 1].entries())
  if (inputs[index]!.template['analysis conditions']['analysis type'] !== type)
    throw new Error('Method mismatch');
for (const { template } of inputs) {
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
    collection['use target pressure'] !== true ||
    !Array.isArray(collection.pressures) ||
    !collection.pressures.length ||
    collection.pressures.length > 256 ||
    !template.softwareVersion ||
    !template.clientVersion
  )
    throw new Error(
      'Expected complete, linked N2 properties and a relative target-pressure program',
    );
}
const profiles = inputs.slice(0, 2).map(({ template, origin }, index) => {
  const product = index === 0 ? 'g5' : 'g12';
  // Only serialized configuration groups: never carry sample identity, measurements or reports.
  const configuration = Object.fromEntries(
    [
      'softwareVersion',
      'clientVersion',
      'sample tube',
      'analysis conditions',
      'labType',
      'originalVolume',
      'thermalCorrection',
      'enableNoiseRejection',
      'enableReferenceTube',
      'systemVolume',
      'upperVolume',
      'lowerVolume',
      'leakRateCorrectMode',
      'leakRate',
    ]
      .filter((key) => Object.hasOwn(template, key))
      .map((key) => [key, structuredClone(template[key])]),
  );
  const free = configuration['analysis conditions']['free space options'];
  delete configuration['analysis conditions']['isotherm collection'];
  configuration.mass = { density: template.mass.density, isEnter: template.mass.isEnter };
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
    configuration,
  };
});
const programs = Object.fromEntries(
  ['bet', 'micropore', 'mesopore'].map((method, index) => {
    const { template, origin } = inputs[index]!;
    const collection = template['analysis conditions']['isotherm collection'];
    return [
      method,
      {
        origin,
        collection: {
          'absolute pressure dosing': collection['absolute pressure dosing'],
          'use target pressure': true,
          'minimum equilibration delay at p/p0 >= 0.995':
            collection['minimum equilibration delay at p/p0 >= 0.995'],
          pressures: collection.pressures,
          increments: null,
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
  JSON.stringify({ revision: 'sam-profiles-v1', profiles, programs }, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    output,
    profiles: profiles.map(({ id }) => id),
    programs: Object.keys(programs),
  }),
);
