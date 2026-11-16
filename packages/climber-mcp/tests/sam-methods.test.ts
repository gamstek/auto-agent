import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateSam, samProfiles } from '../src/sam/sam-generate.js';
import { writeSam } from '../src/sam/sam-write.js';

test('method discovery is product-specific: Climber has no micropore analysis', async () => {
  const catalog = await samProfiles({});
  const profiles = catalog.profiles as { product: string; methods: string[] }[];
  assert.deepEqual(profiles.find(({ product }) => product === 'g5')!.methods, ['bet', 'mesopore']);
  assert.deepEqual(
    new Set(profiles.find(({ product }) => product === 'g12')!.methods),
    new Set(['bet', 'mesopore', 'micropore']),
  );
});

test('Climber rejects micropore settings while SiCOPE still generates its native analysis code', async () => {
  await assert.rejects(generateSam({ product: 'g5', settings: { analysisType: 'micropore' } }), {
    publicCode: 'UNSUPPORTED_ANALYSIS_TYPE',
  });
  for (const [product, method, code] of [
    ['g5', 'bet', 0],
    ['g5', 'mesopore', 1],
    ['g12', 'micropore', 10],
  ] as const) {
    const generated = await generateSam({
      product,
      settings: { analysisType: method, reportTypes: [5, 6] },
    });
    const input = generated.input as { template: Record<string, unknown> };
    const conditions = input.template['analysis conditions'] as Record<string, unknown>;
    assert.equal(conditions['analysis type'], code);
  }
});

test('a complete raw configuration cannot bypass the Climber micropore creation restriction', async () => {
  const generated = await generateSam({
    product: 'g5',
    settings: { analysisType: 'bet', reportTypes: [5, 6] },
  });
  const input = generated.input as Record<string, unknown> & { template: Record<string, unknown> };
  const conditions = input.template['analysis conditions'] as Record<string, unknown>;
  for (const code of [5, 9]) {
    conditions['analysis type'] = code;
    await assert.rejects(writeSam(input, 'create'), { publicCode: 'UNSUPPORTED_ANALYSIS_TYPE' });
  }
});
