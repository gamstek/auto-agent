import { expect, test } from 'bun:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers';
import { referenceSamFixture } from '../case-helpers';
import { WikiLibrary, ParserRegistry } from '@auto-agent/wiki-core';
import { samParser } from '@auto-agent/wiki-sam';
import {
  extractReference,
  referenceEvidence,
} from '@auto-agent/wiki-sam/reference';

test('core extraction retains treatment text, raw units, historical mode and inactive/false/zero/missing values without importing outputs', () => {
  const bytes = referenceSamFixture();
  const root = JSON.parse(new TextDecoder('utf-16be').decode(bytes.subarray(8)));
  const reference = extractReference(root);
  expect(reference.groups.pretreatment!.fields['1']).toMatchObject({
    label: 'Pretreatment',
    value: 'REFERENCE_PRETREATMENT 真空350℃，6小时',
  });
  expect(reference.groups.pretreatment!.fields['2']!.source).toEqual(['base infos', 2, 'value']);
  expect(reference.groups.overview!.fields.labType).toMatchObject({
    value: 1,
    normalized: { value: 'high-throughput' },
  });
  expect(root.labType).toBe(1);
  expect(reference.groups.preparation!.fields['evacuation time']).toMatchObject({
    value: 1.25,
    unit: 'h',
  });
  expect(reference.groups.preparation!.fields['leak test duration']).toMatchObject({
    value: 0,
    presence: 'value',
    unit: 's',
  });
  expect(reference.groups.sample!.fields.isEnter!.value).toBe(false);
  expect(reference.groups.collection!.fields.D_DoseAmount).toMatchObject({
    value: 25,
    active: false,
  });
  expect(reference.groups.collection!.fields.T_DoseAmount).toMatchObject({
    value: 0,
    active: true,
  });
  expect(reference.groups.collection!.fields['first pressure fixed dose']).toMatchObject({
    value: 0,
    active: false,
  });
  expect(reference.groups.backfill!.fields['backfill sample at end of analysis']!.presence).toBe(
    'missing',
  );
  root['analysis conditions']['p0 and temperature options']['p0 and temp adsorptive id'] = 99;
  root.reports[2].options.selected = true;
  root.reports[2].options.selectedFile.filePathName = '';
  const unresolved = extractReference(root);
  expect(unresolved.issues.some((issue) => issue.startsWith('GAS_LINK_MISMATCH'))).toBe(true);
  expect(unresolved.issues.some((issue) => issue.startsWith('MODEL_REFERENCE_UNRESOLVED'))).toBe(
    true,
  );
  expect(unresolved.groups.temperature!.fields['p0 and temp adsorptive id']!.value).toBe(99);
  const serialized = JSON.stringify(reference);
  for (const excluded of [
    'DO_NOT_INDEX_OPERATOR',
    'DO_NOT_INDEX_PLOT',
    'DO_NOT_INDEX_TRAJECTORY',
    'DO_NOT_INDEX_OLD_SAMPLE',
    '987654321',
    '87654321',
    '7654321',
    '654321',
    'C:\\\\Users',
  ])
    expect(serialized).not.toContain(excluded);
  expect(reference.groups.gas!.fields['fluid properties file']!.value).toBe('N2.FPI');
  expect(reference.groups.temperature!.fields.temperature!.normalized!.value as number).toBeCloseTo(
    77.3,
  );
  expect(reference.reports[0]!.parameters.fitRange!.value).toEqual({ min: 0.045, max: 0.31 });
  expect(reference.reports[1]!.parameters.computed!.value).toBe(true);
  expect(reference.reports[2]!.parameters.poreVolumes).toMatchObject({
    value: [2, 50],
    scope: 'uninterpreted',
    active: false,
  });
  expect(reference.reports[2]!.parameters.selectedFile!.value).toEqual({
    filePathName: 'zzinactivekerneluniquerefzz.kernel',
    geometry: 1,
  });
  expect(referenceEvidence(reference).find((item) => item.text.includes('350℃'))).toMatchObject({
    path: ['base infos', 1, 'value'],
    section: 'sample',
  });
});

test('core reference limits fail explicitly rather than truncate pretreatment or return a partial table', () => {
  expect(() =>
    extractReference({ 'base infos': [{ title: 'Pretreatment', value: 'x'.repeat(8193) }] }),
  ).toThrow('structural limits');
  expect(() =>
    extractReference({
      'analysis conditions': {
        'adsorptive properties': {
          'Psat vs Temperature Table': Array.from({ length: 257 }, () => ({
            temperature: 1,
            Psat: 2,
          })),
        },
      },
    }),
  ).toThrow('256 rows');
  const reference = extractReference({
    'analysis conditions': { 'sample backfill options': { 'backfill gas': null } },
  });
  expect(reference.groups.backfill!.fields['backfill gas']).toMatchObject({
    presence: 'null',
    value: null,
  });
});

test('conditional volumes and durations retain values but respect product-specific modes and enable switches', () => {
  const root = {
    'analysis conditions': {
      'free space options': {
        'free space option type': 1,
        'enter ambient free space': 8,
        'outgas test': false,
        'outgas test duration': 30,
        'ambient free space after': 9,
      },
      'preparation options': { 'leak test': false, 'leak test duration': 60 },
      'sample backfill options': {
        'backfill sample at start of analysis': false,
        'backfill sample at end of analysis': false,
        'backfill gas': 2,
      },
    },
  };
  const g5 = extractReference(root, 'g5');
  const g12 = extractReference(root, 'g12');
  expect(g5.groups.freeSpace!.fields['enter ambient free space']).toMatchObject({
    value: 8,
    scope: 'sample-context',
    active: true,
  });
  expect(g12.groups.freeSpace!.fields['enter ambient free space']!.active).toBe(false);
  expect(g5.groups.freeSpace!.fields['ambient free space after']!.active).toBe(false);
  expect(g12.groups.freeSpace!.fields['ambient free space after']!.active).toBe(true);
  expect(g5.groups.preparation!.fields['leak test duration']).toMatchObject({
    value: 60,
    active: false,
  });
  expect(g5.groups.freeSpace!.fields['outgas test duration']).toMatchObject({
    value: 30,
    active: false,
  });
  expect(g5.groups.backfill!.fields['backfill gas']).toMatchObject({ value: 2, active: false });
  expect(
    extractReference(root).groups.freeSpace!.fields['enter ambient free space']!.active,
  ).toBeNull();
});

test('unified search and versioned units expose reference settings and invalidate parser caches', async () => {
  const f = await fixture();
  const root = join(f.dir, 'cases');
  await mkdir(root);
  const source = join(root, 'case.SAM');
  const original = referenceSamFixture();
  await writeFile(source, original);
  const parser = { ...samParser, version: 'fixture-1' };
  const index = new WikiLibrary(join(f.config.dataDir, 'wiki.sqlite'), new ParserRegistry([parser]));
  const sources = [{ id: 'cases', type: 'directory' as const, path: root }];
  try {
    await index.build(sources, new AbortController().signal);
    const search = index.search({
      query: 'REFERENCE_PRETREATMENT',
      filters: [{ field: 'sam.labType', op: 'eq', value: 1 }],
    });
    expect(search.results).toHaveLength(1);
    expect(search.results[0]!.attributes).toMatchObject({ 'sam.labType': 1 });
    expect(index.search({ filters: [{ field: 'sam.labType', op: 'eq', value: 0 }] }).results).toHaveLength(0);
    expect(index.search({ query: 'DO_NOT_INDEX_OPERATOR' }).results).toHaveLength(0);
    const reference = search.results[0]!.reference;
    const read = index.read({ reference, maxBytes: 5000 });
    expect(read.units[0]!.data).toMatchObject({ value: 'REFERENCE_PRETREATMENT 真空350℃，6小时' });
    expect(read.units[0]!.locator).toEqual({ kind: 'json-pointer', pointer: '/base infos/1/value' });
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(5000);
    const fit = index.search({ query: 'fitRange' }).results[0]!;
    expect(index.read({ reference: fit.reference }).units[0]!.data).toMatchObject({ value: { min: 0.045, max: 0.31 } });
    parser.version = 'fixture-2';
    expect(await index.build(sources, new AbortController().signal)).toMatchObject({
      rebuilt: 1,
      reused: 0,
    });
    expect(await readFile(source)).toEqual(original);
  } finally {
    await index.close();
    await f.cleanup();
  }
});
