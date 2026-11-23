import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fitBet } from '../../corax/lib/report-analysis/bet';
import { kernelResponse, parseKernel } from '../../corax/lib/report-analysis/kernel';
import { loadModel, modelIds } from 'auto-agent/nldft-models';
import { fitNldft } from '../../corax/lib/report-analysis/nldft';
import { parseReportPages, readReport } from '../../corax/lib/report-analysis/pdf';

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
    const bet = fitBet(report.branches.adsorption);
    assert.ok(Math.abs(bet.areaM2G! - 1521.4283) < 0.001);
    assert.ok(bet.c! < 0);
    assert.equal(bet.selected.length, 10);
    const kernel = await loadModel('model001', projectRoot);
    const fit = await fitNldft(kernel, report.branches.adsorption);
    assert.ok(fit.converged);
    assert.ok(fit.rmse < 50, String(fit.rmse));
    assert.ok(fit.distribution.every((bin) => bin.poreVolumeCm3G >= 0));
    assert.ok(fit.totalPoreVolumeCm3G > 0);
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
