import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSamFile } from '../src/sam/index';
import { generateSam } from '../src/sam/sam-generate.js';
import { writeSam } from '../src/sam/sam-write.js';
import { inspectSam } from '../src/sam/sam.js';
import { SUMMARY_REPORT_FLAGS } from '../src/sam/summary-report.js';

const bet = {
  enabledFields: ['showSinglePointBET', 'showMultiPointBET'],
  adsorptionPoresAtPP0: 0.99405431,
  desorptionPoresAtPP0: 0.95,
};
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'sam-summary-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const rootOf = (bytes: Buffer) => JSON.parse(new TextDecoder('utf-16be').decode(bytes.subarray(8)));

test('the documented BET example writes only the two requested summary metrics and verifies both thresholds', async () => {
  await fixture(async (directory) => {
    const guidance = await readFile(
      new URL('../../../corax/skills/device-automation/references/sam-create.md', import.meta.url),
      'utf8',
    );
    const example = JSON.parse(/```json\s*\n([\s\S]*?)\n```/.exec(guidance)![1]!);
    assert.deepEqual(example.settings.summaryReport, bet);
    for (const product of ['g5', 'g12'] as const) {
      const path = join(directory, `${product}.SAM`);
      const created = (await writeSam({ ...example, product, path }, 'create')) as any;
      assert.equal(created.written, true);
      assert.equal(created.generation.defaultedFields.includes('summaryReport'), false);
      const root = rootOf(await readFile(path));
      const options = root.reports.find((report: any) => report.type === 1).options;
      assert.deepEqual(
        SUMMARY_REPORT_FLAGS.filter((key) => options[key]),
        bet.enabledFields,
      );
      assert.equal(options.adsorptionPoresAtPP0, bet.adsorptionPoresAtPP0);
      assert.equal(options.desorptionPoresAtPP0, bet.desorptionPoresAtPP0);
      assert.equal(root.reports.length, product === 'g5' ? 13 : 11);
      const checked = (await inspectSam(
        { path, product, requirements: { summaryReport: bet } },
        'compare',
      )) as any;
      assert.equal(checked.comparison.overall, 'match');
      assert.equal(checked.comparison.checks.length, 3);
      assert.deepEqual(checked.summaryReport.enabledFields, bet.enabledFields);
    }
  });
});

test('mesopore and SiCOPE micropore accept distinct explicit summary lists rather than sharing profile defaults', async () => {
  await fixture(async (directory) => {
    // Explicit fixture choices exercise the API; they do not resolve the document's two ambiguous BJH labels.
    const mesopore = {
      ...bet,
      enabledFields: [
        ...bet.enabledFields,
        'showAveragePoreDiameter',
        'showAdsorptionTotalPoreVolume',
      ],
    };
    const micropore = {
      ...bet,
      adsorptionPoresAtPP0: 0.95,
      enabledFields: [...mesopore.enabledFields, 'showt_PlotMicroporeArea', 'showNLDFTPoreSize'],
    };
    for (const [product, analysisType, summaryReport] of [
      ['g5', 'mesopore', mesopore],
      ['g12', 'micropore', micropore],
    ] as const) {
      const path = join(directory, `${analysisType}.SAM`);
      await writeSam(
        {
          product,
          path,
          settings: { analysisType, reportTypes: [1, 5, 6, 13, 14], summaryReport },
        },
        'create',
      );
      const checked = (await inspectSam(
        {
          path,
          product,
          requirements: {
            summaryReport: {
              ...summaryReport,
              enabledFields: [...summaryReport.enabledFields].reverse(),
            },
          },
        },
        'compare',
      )) as any;
      assert.equal(checked.comparison.overall, 'match');
      const mismatch = (await inspectSam(
        { path, product, requirements: { summaryReport: bet } },
        'compare',
      )) as any;
      assert.equal(mismatch.comparison.overall, 'mismatch');
    }
  });
});

test('summary-only modify/save-as preserve report options, unknown extensions, identity and source hash checks', async () => {
  await fixture(async (directory) => {
    const path = join(directory, 'source.SAM');
    const generated = await generateSam({
      product: 'g5',
      path,
      settings: {
        analysisType: 'bet',
        summaryReport: bet,
        sampleName: 'Summary fixture',
        sampleMassG: 1,
        tubeMassG: 20,
      },
    });
    const input = generated.input as any;
    const summary = input.template.reports.find((report: any) => report.type === 1);
    summary.options.vendorExtension = { keep: 'native' };
    const created = (await writeSam(input, 'create')) as any;
    const before = rootOf(await readFile(path));
    const modified = (await writeSam(
      {
        path,
        product: 'g5',
        expectedSha256: created.file.sha256,
        summaryReport: { adsorptionPoresAtPP0: 0.98 },
      },
      'modify',
    )) as any;
    assert.equal(modified.identity.uuid, created.identity.uuid);
    assert.deepEqual(modified.summaryReport.enabledFields, bet.enabledFields);
    assert.ok(modified.summaryReport.extraKeys.includes('vendorExtension'));
    const after = rootOf(await readFile(path));
    before.reports[0].options.adsorptionPoresAtPP0 = 0.98;
    assert.deepEqual(after, before);
    const saved = (await writeSam(
      {
        path: join(directory, 'copy.SAM'),
        sourcePath: path,
        product: 'g5',
        expectedSha256: modified.file.sha256,
        summaryReport: { enabledFields: ['showMultiPointBET'] },
      },
      'save-as',
    )) as any;
    assert.deepEqual(saved.summaryReport.enabledFields, ['showMultiPointBET']);
    assert.deepEqual(rootOf(await readFile(path)), after);
    assert.deepEqual(rootOf(await readFile(saved.file.path)).reports[0].options.vendorExtension, {
      keep: 'native',
    });
    await assert.rejects(
      writeSam(
        {
          path,
          product: 'g5',
          expectedSha256: created.file.sha256,
          summaryReport: { enabledFields: [] },
        },
        'modify',
      ),
      { publicCode: 'FILE_CHANGED' },
    );
  });
});

test('missing or invalid summary settings are rejected before any file write', async () => {
  await fixture(async (directory) => {
    for (const summaryReport of [
      undefined,
      {},
      { ...bet, enabledFields: ['unknown'] },
      { ...bet, enabledFields: ['showLangmuir', 'showLangmuir'] },
      { ...bet, adsorptionPoresAtPP0: 2 },
    ]) {
      const path = join(directory, 'rejected.SAM');
      const result = (await executeSamFile({
        operation: 'create',
        input: {
          product: 'g5',
          path,
          settings: {
            analysisType: 'bet',
            ...(summaryReport === undefined ? {} : { summaryReport }),
          },
        },
      })) as any;
      assert.equal(result.writeOutcome, 'not-started');
      assert.ok(['MISSING_SUMMARY_REPORT', 'INVALID_SUMMARY_REPORT'].includes(result.error.code));
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    }
  });
});

test('inspection preserves missing/null/false options and cannot report a false match for incomplete summaries', async () => {
  await fixture(async (directory) => {
    const generated = await generateSam({
      product: 'g5',
      settings: { analysisType: 'bet', summaryReport: bet },
    });
    const input = generated.input as any;
    const options = input.template.reports[0].options;
    delete options.showLangmuir;
    options.showHKMedianPoreWidth = null;
    const path = join(directory, 'incomplete.SAM');
    await writeFile(path, JSON.stringify(input.template));
    const inspected = (await inspectSam({ path, product: 'g5' })) as any;
    assert.equal(inspected.summaryReport.enabledFields, null);
    assert.equal(Object.hasOwn(inspected.summaryReport.options, 'showLangmuir'), false);
    assert.equal(inspected.summaryReport.options.showHKMedianPoreWidth, null);
    assert.equal(inspected.summaryReport.options.showNLDFTPoreSize, false);
    const checked = (await inspectSam(
      { path, product: 'g5', requirements: { summaryReport: bet } },
      'compare',
    )) as any;
    assert.equal(checked.comparison.overall, 'unknown');
  });
});

test('a product-family mismatch cannot certify summary options even when their raw keys agree', async () => {
  await fixture(async (directory) => {
    const path = join(directory, 'climber.SAM');
    await writeSam(
      { product: 'g5', path, settings: { analysisType: 'bet', summaryReport: bet } },
      'create',
    );
    const checked = (await inspectSam(
      { path, product: 'g12', requirements: { summaryReport: bet } },
      'compare',
    )) as any;
    assert.equal(checked.summaryReport.supported, false);
    assert.equal(checked.summaryReport.enabledFields, null);
    assert.equal(checked.comparison.overall, 'unknown');
    assert.ok(checked.comparison.checks.every((check: any) => check.status === 'unsupported'));
  });
});
