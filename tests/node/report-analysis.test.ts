import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { calculateIsotherm, isothermSchema } from 'auto-agent/report-analysis';
import { kernelResponse, parseKernel } from '../../corax/lib/report-analysis/g12/kernel';
import { loadModel, modelIds } from 'auto-agent/nldft-models';
import { fitNldft } from '../../corax/lib/report-analysis/solvers/nldft';
import { parseReportPages, readReport } from '../../corax/lib/report-analysis/report/pdf';
import { planSupplement } from '../../corax/lib/report-analysis/report/supplement';
import { exportSupplementPdf } from '../../corax/lib/report-analysis/report/export-pdf';
import { fitBjh } from '../../corax/lib/report-analysis/solvers/bjh';

const synthetic = () =>
  parseKernel(
    Uint8Array.from(
      new TextEncoder()
        .encode(
          [
            'N2(77K), Carbon Slit Pores, NLDFT;0',
            '2,4,8',
            '4,0,0',
            '0.001,0,0',
            '0.01,0,0',
            '0.1,0,0',
            '0.9,4,0.5',
            '0.9,8,1',
            '0.9,9,4',
            '0.9,10,12',
          ].join('\n'),
        )
        .reverse(),
      (b) => b ^ 71,
    ),
  );

test('G12 decoding aligns the offset response rows and NNLS recovers two known pore contributions', async () => {
  const kernel = synthetic();
  assert.deepEqual(kernel.widths, [4, 8]);
  const points = [2.75, 5.5, 10.5, 23].map((q, i) => ({
    pp0: kernel.pressures[i],
    uptake: q * 22.414,
  }));
  const result = await fitNldft(kernel, points, { lambda: 0 });
  assert.equal(result.converged, true);
  assert.ok(result.rmse < 0.002);
  assert.ok(Math.abs(result.distribution[0].poreVolumeCm3G - 0.5) < 0.0001);
  assert.ok(Math.abs(result.distribution[1].poreVolumeCm3G - 1.5) < 0.0001);
  assert.ok(Math.abs(result.totalPoreVolumeCm3G - 2) < 0.0001);
});

test('report extraction does not confuse an early pressure rollback or HK results with desorption', () => {
  const pressures = [0.000008, 0.000006, 0.03, 0.6, 0.99, 0.9, 0.8, 0.7];
  const report = parseReportPages([
    {
      page: 1,
      lines: [
        'SiCOPE',
        '分析口1',
        '样品名称：样品 A',
        '文件路径：E:/SiCOPE/A_',
        'Port1.SAM',
        '测试气体： N2',
        '测试温度： -195.850 ℃',
        '概要报告',
        'BET比表面积： 1521.4283 m²/g',
      ],
    },
    {
      page: 3,
      lines: [
        '等温线表格报告',
        '吸附量 (cm³/g STP)',
        '01:25 760.00',
        ...pressures.map((p, i) => `${p} ${p * 760} ${i + 1} 02:00 760`),
      ],
    },
    { page: 7, lines: ['Horvath-Kawazoe 报告', '0.4 304 20 02:00 760'] },
  ]);
  assert.equal(report.sample.sam, 'E:/SiCOPE/A_Port1.SAM');
  assert.equal(report.sample.temperatureK, 77.3);
  assert.equal(report.summaryMetrics[0].value, 1521.4283);
  assert.equal(report.rejectedRows, 1);
  assert.deepEqual(
    report.branches.adsorption.map((p) => p.pp0),
    pressures.slice(0, 5),
  );
  assert.deepEqual(
    report.branches.desorption.map((p) => p.pp0),
    pressures.slice(5),
  );
});

test('isolated desorption retains its highest-pressure point and verified units are normalized', () => {
  const report = parseReportPages([
    { page: 1, lines: ['SiCOPE'] },
    {
      page: 2,
      lines: [
        '等温线表格报告',
        '样品:脱附',
        '吸附量 (mmol/g)',
        '0.8 608 1 01:00 760',
        '0.7 532 0.8 02:00 760',
        '0.6 456 0.7 03:00 760',
        '0.5 380 0.6 04:00 760',
      ],
    },
    { page: 3, lines: ['等温线表格报告', '吸附量 (cm³/g)', '0.4 304 0.5 05:00 760'] },
  ]);
  assert.equal(report.branchSource, 'labeled-desorption');
  assert.deepEqual(report.branches.adsorption, []);
  assert.deepEqual(
    report.branches.desorption.map((p) => p.pp0),
    [0.8, 0.7, 0.6, 0.5],
  );
  assert.equal(report.branches.desorption[0].uptake, 22.414);
  assert.deepEqual(report.unverifiedUnitPages, [3]);
  assert.equal(report.rejectedRows, 1);
});

const pdfPath = process.env.SICOPE_REPORT_FIXTURE;
test('an explicitly adsorption-only table does not acquire a desorption branch from a pressure reversal', () => {
  const points = [0.1, 0.4, 0.85, 0.79, 0.7, 0.6];
  const report = parseReportPages([
    { page: 1, lines: ['SiCOPE'] },
    {
      page: 2,
      lines: [
        '等温线表格报告',
        'N2:吸附',
        '吸附量 (cm³/g STP)',
        ...points.map((p, index) => `${p} ${p * 760} ${index + 1} 01:00 760`),
      ],
    },
  ]);
  assert.equal(report.branchSource, 'unknown');
  assert.equal(report.points.length, 6);
  assert.deepEqual(report.branches, { adsorption: [], desorption: [] });
});
const projectRoot = resolve(import.meta.dirname, '../../corax');

test('BJH requires three measured desorption points in range before adding the shared point', async () => {
  const [result] = await calculateIsotherm(
    {
      gas: 'N2',
      temperatureK: 77.3,
      uptakeUnit: 'cm3(STP)/g',
      branches: {
        adsorption: [{ pp0: 0.99, uptake: 300 }],
        desorption: [
          { pp0: 0.9, uptake: 220 },
          { pp0: 0.8, uptake: 150 },
          { pp0: 0.2, uptake: 100 },
        ],
      },
    },
    { bjh: [{ branch: 'desorption', minPP0: 0.75 }] },
    undefined,
    projectRoot,
  );
  assert.match(result.error!, /三个实测有效点/);
  assert.ok(!('distribution' in result));
});

test('BJH rejects negative net release and severe reversals but diagnoses small noise', () => {
  const run = (uptake: number[]) =>
    fitBjh(
      uptake.map((q, i) => ({ pp0: [0.99, 0.9, 0.8, 0.7][i], uptake: q })),
      { branch: 'desorption' },
      0.0015468,
      0.953,
    );
  assert.throws(() => run([300, 100, 350, 320]), /高压端吸附量不大于低压端/);
  assert.throws(() => run([300, 100, 150, 90]), /累计反向吸附量/);
  const result = run([300, 220, 221, 100]);
  assert.equal(result.reversedSteps, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('小幅反向波动')));
});

test('supplement PDF includes reported, blocked and pending requests beside a completed result', async () => {
  const report = {
    ...parseReportPages([{ page: 1, lines: ['SiCOPE', '样品名称: Test'] }]),
    sha256: 'a'.repeat(64),
  };
  const [bet, bjh] = await calculateIsotherm(
    {
      gas: 'N2',
      temperatureK: 77.3,
      uptakeUnit: 'cm3(STP)/g',
      branches: {
        adsorption: [
          { pp0: 0.1, uptake: 2 },
          { pp0: 0.2, uptake: 3 },
        ],
        desorption: [],
      },
    },
    { bet: {}, bjh: [{ branch: 'desorption' }] },
    undefined,
    projectRoot,
  );
  assert.equal(bet.error, undefined);
  const dir = await mkdtemp(join(tmpdir(), 'report-outcomes-'));
  try {
    const path = await exportSupplementPdf(
      dir,
      report,
      [bet, bjh],
      undefined,
      [
        { target: 'bet', status: 'calculate' },
        { target: 'bjh_adsorption', status: 'reported' },
        { target: 'bjh_desorption', status: 'blocked', reason: 'Missing desorption measurements.' },
        {
          target: 'nldft',
          status: 'needs_model',
          reason: '请按已确认的材料、孔形及分支选择模型核。',
        },
      ],
      'en',
    );
    const pdfModule = createRequire(join(projectRoot, 'package.json')).resolve(
      'pdfjs-dist/legacy/build/pdf.mjs',
    );
    const { getDocument } = await import(pathToFileURL(pdfModule).href);
    const task = getDocument({ data: new Uint8Array(await readFile(path)) });
    try {
      const pdf = await task.promise;
      const content = await (await pdf.getPage(1)).getTextContent();
      const text = content.items.map((item: { str?: string }) => item.str ?? '').join(' ');
      assert.match(text, /bet: calculated/);
      assert.match(text, /bjh_adsorption: reported/);
      assert.match(text, /bjh_desorption: blocked \| Missing desorption measurements/);
      assert.match(text, /nldft: needs_model \| Choose a model kernel/);
      assert.match(text, /No usable desorption data points/);
      const details = await (await pdf.getPage(2)).getTextContent();
      const detailsText = details.items.map((item: { str?: string }) => item.str ?? '').join(' ');
      assert.match(detailsText, /Only two points were fitted/);
    } finally {
      await task.destroy();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const nitrogenIsotherm = isothermSchema.parse({
  gas: 'N2',
  temperatureK: 77.3,
  uptakeUnit: 'cm3(STP)/g',
  branches: {
    adsorption: [
      { pp0: 0.1, uptake: 2 },
      { pp0: 0.2, uptake: 3 },
    ],
  },
});

test('independent calculations reject invalid units, point values and options at runtime', async () => {
  const invalidUnit = { ...nitrogenIsotherm, uptakeUnit: 'mol/g' };
  await assert.rejects(
    calculateIsotherm(
      invalidUnit as unknown as typeof nitrogenIsotherm,
      { bet: {} },
      undefined,
      projectRoot,
    ),
    /uptakeUnit/,
  );
  await assert.rejects(
    calculateIsotherm(
      {
        ...nitrogenIsotherm,
        branches: { adsorption: [{ pp0: 0.1, uptake: Infinity }], desorption: [] },
      },
      { bet: {} },
      undefined,
      projectRoot,
    ),
    /uptake/,
  );
  await assert.rejects(
    calculateIsotherm(nitrogenIsotherm, { bet: { crossSectionNm2: -1 } }, undefined, projectRoot),
    /crossSectionNm2/,
  );
});

test('BET suppresses area for a negative monolayer capacity while retaining fit diagnostics', async () => {
  const [result] = await calculateIsotherm(
    {
      ...nitrogenIsotherm,
      branches: {
        adsorption: [
          { pp0: 0.1, uptake: 0.1 },
          { pp0: 0.2, uptake: 10 },
        ],
        desorption: [],
      },
    },
    { bet: {} },
    undefined,
    projectRoot,
  );
  assert.ok('areaM2G' in result);
  assert.equal(result.status, 'invalid');
  assert.equal(result.areaM2G, null);
  assert.ok(result.qm! < 0);
  assert.ok(result.warnings.some((warning) => warning.includes('单层吸附量')));
});

test('ADS lookup distinguishes missing temperature matches from ambiguous candidates', async () => {
  const data = { ...nitrogenIsotherm, temperatureK: 295 };
  await assert.rejects(
    calculateIsotherm(data, { bet: {} }, undefined, projectRoot),
    (error: Error) => {
      assert.match(error.message, /295 K 匹配的内置 \.ADS/);
      assert.doesNotMatch(error.message, /请确认 adsId|nitrogen\.ADS|nitrogen2\.ADS/);
      return true;
    },
  );
  await assert.rejects(
    calculateIsotherm(data, { bet: {}, adsId: 'nitrogen.ADS' }, undefined, projectRoot),
    /标称温度与实验不匹配/,
  );
});

test('independent BET uses matching argon properties and diagnoses a two-point fit', async () => {
  const data = isothermSchema.parse({
    gas: 'Ar',
    temperatureK: 87.29,
    uptakeUnit: 'mmol/g',
    branches: {
      adsorption: [
        { pp0: 0.1, uptake: 2 },
        { pp0: 0.2, uptake: 3 },
      ],
    },
  });
  const [result] = await calculateIsotherm(data, { bet: {} }, undefined, projectRoot);
  assert.equal(result.model, 'BET');
  assert.ok('areaM2G' in result);
  assert.equal(result.properties.id, 'arlar.ADS');
  assert.equal(result.crossSectionNm2, 0.142);
  assert.equal(result.selected[0].uptake, 44.828);
  assert.equal(result.fitPointCount, 2);
  assert.equal(result.betsiEnabled, false);
  assert.ok(result.warnings.some((warning) => warning.includes('两个拟合点')));
  const [mismatch] = await calculateIsotherm(
    data,
    { nldft: [{ modelId: 'model001' }] },
    undefined,
    projectRoot,
  );
  assert.ok('error' in mismatch);
  assert.match(mismatch.error!, /气体或温度/);
  await assert.rejects(
    calculateIsotherm(
      { ...data, gas: 'CO2', temperatureK: 298.15 },
      { bet: {} },
      undefined,
      projectRoot,
    ),
    /CO2-298\.15K\.ADS.*co2_25\.ADS|co2_25\.ADS.*CO2-298\.15K\.ADS/,
  );
});

test('all bundled G12 models resolve by ID and pass integrity and response checks', async () => {
  assert.equal(modelIds.length, 15);
  for (const id of modelIds) {
    const kernel = await loadModel(id, projectRoot);
    assert.ok(kernelResponse(kernel, kernel.pressures[0]).every(Number.isFinite), id);
  }
});

test(
  'local SiCOPE PDF and built-in G12 model: parse, BET parity and independent NLDFT',
  { skip: !pdfPath },
  async () => {
    const report = await readReport(pdfPath!);
    assert.equal(report.points.length, 73);
    assert.equal(report.branches.adsorption.length, 50);
    assert.equal(report.branches.desorption.length, 23);
    const results = await calculateIsotherm(
      { ...report.sample, branches: report.branches, uptakeUnit: 'cm3(STP)/g' },
      {
        bet: {},
        nldft: [{ modelId: 'model001' }],
        bjh: [{ branch: 'adsorption' }, { branch: 'desorption' }],
      },
      undefined,
      projectRoot,
    );
    const bet = results[0];
    const fit = results.find((result) => result.model === 'NLDFT');
    const ads = results.find((result) => result.model === 'BJH' && result.branch === 'adsorption');
    const des = results.find((result) => result.model === 'BJH' && result.branch === 'desorption');
    assert.ok('areaM2G' in bet && fit && 'distribution' in fit);
    assert.ok(ads && 'totalAreaM2G' in ads && des && 'totalAreaM2G' in des);
    assert.ok(Math.abs(ads.totalAreaM2G - 193.4129) < 0.001);
    assert.ok(Math.abs(des.totalAreaM2G - 157.8203) < 0.001);
    assert.equal(des.sharedTurningPoint, true);
    assert.equal(bet.properties.id, 'nitrogen.ADS');
    assert.equal(fit.kernel.configuration.geometry, 'Slit');
    assert.ok(Math.abs(bet.areaM2G! - 1521.4283) < 0.001);
    assert.ok(bet.c! < 0);
    assert.equal(bet.status, 'warning');
    assert.equal(bet.selected.length, 10);
    assert.ok(bet.selected.every((point) => 'page' in point));
    assert.ok(fit.converged);
    assert.ok(fit.rmse < 50, String(fit.rmse));
    assert.ok(fit.distribution.every((bin) => bin.poreVolumeCm3G >= 0));
    assert.ok(fit.totalPoreVolumeCm3G > 0);
    assert.ok(Math.abs(fit.poreBands.at(-1)!.cumulativeCm3G - fit.totalPoreVolumeCm3G) < 1e-10);
    console.log(
      JSON.stringify({
        bet: bet.areaM2G,
        c: bet.c,
        nldft: {
          lambda: fit.lambda,
          rmse: fit.rmse,
          poreVolume: fit.totalPoreVolumeCm3G,
          selection: fit.selection,
        },
      }),
    );
  },
);

const pcPath = process.env.SICOPE_PC_FIXTURE;
test(
  'PC-C supplement leaves reported items alone and blocks missing desorption',
  { skip: !pcPath },
  async () => {
    const report = await readReport(pcPath!);
    const { plan, options } = await planSupplement(
      report,
      ['bet', 'bjh_adsorption', 'bjh_desorption', 'nldft'],
      {},
      undefined,
      projectRoot,
    );
    assert.deepEqual(
      plan.map(({ status }) => status),
      ['reported', 'reported', 'blocked', 'needs_model'],
    );
    assert.deepEqual(options.nldft, undefined);
    assert.ok(plan[3].candidates?.some(({ modelId }) => modelId === 'model001'));
    assert.ok(!plan[3].candidates?.some(({ modelId }) => modelId === 'model102'));
    const results = await calculateIsotherm(
      { ...report.sample, branches: report.branches, uptakeUnit: 'cm3(STP)/g' },
      {
        bet: { betsi: {} },
        bjh: [{ branch: 'desorption' }],
        nldft: [{ modelId: 'model001', minPP0: 0.01, maxPP0: 0.9933 }],
      },
      undefined,
      projectRoot,
    );
    const [bet, des, fit] = results;
    assert.ok(bet.model === 'BET' && 'areaM2G' in bet && bet.betsiEnabled);
    assert.ok(Math.abs(bet.areaM2G! - 1786.7436) < 0.001);
    assert.match(des.error!, /脱附/);
    assert.ok(fit.model === 'NLDFT' && 'poreBands' in fit && fit.poreBands);
    assert.ok(Math.abs(fit.poreBands[1].volumeCm3G - 0.2870779) < 0.0001);
    const dir = await mkdtemp(join(tmpdir(), 'report-supplement-'));
    try {
      const path = await exportSupplementPdf(dir, report, results);
      const bytes = await readFile(path);
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      assert.ok((await readReport(path)).sample);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
