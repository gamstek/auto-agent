import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { referenceSource } from 'auto-agent/wiki';
import { queryReference, referenceInput } from 'auto-agent/wiki/reference';

test('generic Wiki reference collection preserves immutable evidence and supports metadata filters', () => {
  const source = referenceSource(resolve(import.meta.dirname, '../../corax'));
  const catalog = queryReference(referenceInput.parse({ action: 'catalog' }), source) as any;
  expect(catalog.documentCount).toBe(178);
  expect(catalog.readOnly).toBe(true);
  expect(catalog.filterKeys).toContain('sam.product');
  const results = queryReference(
    referenceInput.parse({
      action: 'search',
      query: 'BET',
      filters: { 'sam.product': 'g5' },
      limit: 1,
    }),
    source,
  ) as any;
  expect(results.results).toHaveLength(1);
  const hit = results.results[0];
  expect(hit.title).toMatch(/^case-[a-f0-9]{64}\.(SAM|SMP)$/);
  expect(hit.origin).toMatch(/^[^/]+\/case-[a-f0-9]{64}\.(SAM|SMP)$/);
  expect(hit.attributes['sam.product']).toBe('g5');
  expect(hit.reference.assetSha256).toBe(catalog.assetSha256);
  const evidence = queryReference(
    referenceInput.parse({ action: 'read', reference: hit.reference }),
    source,
  ) as any;
  expect(evidence.sourceSha256).toBe(hit.sourceSha256);
  expect(evidence.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(evidence.sourceVerified).toBe(false);
  expect(evidence.units.length).toBeGreaterThan(0);
  expect(['[已脱敏]', null, '']).toContain(evidence.units[0].data.identity.sampleName);
  expect(['[已脱敏]', null, '']).toContain(evidence.units[0].data.identity.uuid);
  expect(() =>
    queryReference(
      referenceInput.parse({
        action: 'read',
        reference: { ...hit.reference, assetSha256: '0'.repeat(64) },
      }),
      source,
    ),
  ).toThrow('版本已经变化');
});

test('Wiki collections do not expose Skill guidance, database paths or SQL operations', () => {
  for (const input of [
    { action: 'guidance', name: '选择规则' },
    { action: 'catalog', path: 'arbitrary.sqlite' },
    { action: 'search', query: 'BET', sql: 'SELECT * FROM documents' },
  ])
    expect(referenceInput.safeParse(input).success).toBe(false);
});
