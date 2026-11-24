import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { calculateIsotherm } from '../calculate';
import type { readReport } from './pdf';
import type { SupplementEntry } from './supplement';
import { reportDiagnostic } from './diagnostic-language';

type Report = Awaited<ReturnType<typeof readReport>>;
type Results = Awaited<ReturnType<typeof calculateIsotherm>>;
export type ReportLanguage = 'zh-CN' | 'en';

const fmt = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '-' : Number(n.toPrecision(7)).toString();

export async function exportSupplementPdf(
  dataDir: string,
  report: Report,
  results: Results,
  signal?: AbortSignal,
  plan?: readonly SupplementEntry[],
  language: ReportLanguage = 'zh-CN',
) {
  signal?.throwIfAborted();
  const t = (zh: string, en: string) => (language === 'zh-CN' ? zh : en);
  const diagnostic = (message: string) => reportDiagnostic(message, language);
  const PDFDocument: typeof import('pdfkit') = createRequire(import.meta.url)('pdfkit');
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 66, bottom: 54, left: 48, right: 48 },
    bufferPages: true,
    lang: language,
    info: {
      Title: `${t('SiCOPE 补充分析报告', 'SiCOPE Supplementary Analysis Report')} - ${report.sample.name ?? t('样品', 'Sample')}`,
    },
  });
  const buffers: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => buffers.push(chunk));
    doc.once('end', () => resolve(Buffer.concat(buffers)));
    doc.once('error', reject);
  });
  // PDFKit needs a CJK font to embed Chinese sample names and diagnostics.
  const fonts = [
    { path: join(process.env.WINDIR ?? 'C:/Windows', 'Fonts/msyh.ttc'), face: 'MicrosoftYaHei' },
    {
      path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
      face: 'NotoSansCJKsc-Regular',
    },
  ];
  let unicode = false;
  for (const { path, face } of fonts) {
    if (!existsSync(path)) continue;
    try {
      doc.font(path, face);
      unicode = true;
      break;
    } catch {
      /* try the next font */
    }
  }
  if (language === 'zh-CN' && !unicode) {
    (doc as unknown as import('node:stream').Readable).destroy();
    throw new Error('缺少可用于生成中文 PDF 的字体，请安装 Microsoft YaHei 或 Noto Sans CJK SC。');
  }
  if (!unicode) doc.font('Helvetica');
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bodyWidth = right - left;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const clean = (s: unknown) => {
    const text = String(s ?? '-').replace(/[\u0000-\u001f]/g, ' ');
    return unicode
      ? text
      : text.replace(/[^\x20-\x7e]/gu, (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`);
  };
  const title = (s: string) => {
    if (doc.y + 56 > bottom()) doc.addPage();
    const y = doc.y + 14;
    doc.fontSize(14).fillColor('#20272d').text(s, left, y, { width: bodyWidth, align: 'center' });
    doc
      .strokeColor('#aab5bd')
      .lineWidth(0.5)
      .moveTo(left, doc.y + 5)
      .lineTo(right, doc.y + 5)
      .stroke();
    doc.x = left;
    doc.y += 14;
  };
  const line = (s: unknown) => {
    doc
      .fontSize(9)
      .fillColor('#303840')
      .text(clean(s), left, doc.y, { width: bodyWidth, lineGap: 2 });
  };
  type Cells = (string | number | null | undefined)[];
  const table = (
    headers: string[],
    rows: Cells[],
    proportions = headers.map(() => 1 / headers.length),
    numeric: number[] = [],
  ) => {
    const widths = proportions.map((share) => share * bodyWidth);
    const textOf = (v: Cells[number]) => clean(typeof v === 'number' ? fmt(v) : v);
    const heightOf = (values: Cells) => {
      doc.fontSize(9);
      return Math.max(
        23,
        ...values.map(
          (value, i) =>
            doc.heightOfString(textOf(value), { width: widths[i] - 14, lineGap: 2 }) + 10,
        ),
      );
    };
    const row = (values: Cells, height: number, head = false) => {
      const y = doc.y;
      if (head) doc.rect(left, y, bodyWidth, height).fill('#eef2f5');
      doc.fillColor('#303840').fontSize(9);
      let x = left;
      values.forEach((value, i) => {
        doc.text(textOf(value), x + 7, y + 5, {
          width: widths[i] - 14,
          height: height - 8,
          lineGap: 2,
          align: numeric.includes(i) ? 'right' : 'left',
        });
        x += widths[i];
      });
      doc
        .strokeColor('#d7dfe5')
        .lineWidth(0.5)
        .moveTo(left, y + height)
        .lineTo(right, y + height)
        .stroke();
      doc.x = left;
      doc.y = y + height;
    };
    const headerHeight = heightOf(headers);
    if (doc.y + headerHeight + (rows.length ? heightOf(rows[0]) : 0) > bottom()) doc.addPage();
    row(headers, headerHeight, true);
    for (const values of rows) {
      signal?.throwIfAborted();
      const height = heightOf(values);
      if (doc.y + height > bottom()) {
        doc.addPage();
        row(headers, headerHeight, true);
      }
      row(values, height);
    }
    doc.y += 8;
  };
  const fields = (rows: Cells[]) =>
    table([t('项目', 'Item'), t('设置 / 数值', 'Setting / value')], rows, [0.36, 0.64]);
  const pressureRange = (lo: number | undefined, hi: number | undefined) =>
    `${fmt(lo)} – ${fmt(hi)}`;
  const fixed = (s: string, x: number, y: number, centerIn = 0) => {
    const savedX = doc.x,
      savedY = doc.y;
    const text = clean(s);
    doc.text(text, x + (centerIn ? (centerIn - doc.widthOfString(text)) / 2 : 0), y, {
      lineBreak: false,
    });
    doc.x = savedX;
    doc.y = savedY;
  };
  const chart = (
    series: { name: string; points: readonly [number, number][] }[],
    xLabel: string,
    yLabel: string,
  ) => {
    if (doc.y + 244 > bottom()) doc.addPage();
    const x = left + 58,
      y = doc.y + 24,
      w = right - x - 12,
      h = 155;
    const all = series.flatMap((s) => s.points).filter((p) => p.every(Number.isFinite));
    if (all.length < 2) return;
    const minX = Math.min(...all.map((p) => p[0])),
      maxX = Math.max(...all.map((p) => p[0]));
    const minY = Math.min(...all.map((p) => p[1])),
      maxY = Math.max(...all.map((p) => p[1]));
    doc.fontSize(8).fillColor('#16202b');
    fixed(yLabel, x, y - 15);
    doc.strokeColor('#c9d7e2').rect(x, y, w, h).stroke();
    for (let i = 0; i <= 4; i++) {
      const gridY = y + h - (i * h) / 4;
      if (i > 0 && i < 4)
        doc
          .strokeColor('#e1e6ea')
          .lineWidth(0.5)
          .moveTo(x, gridY)
          .lineTo(x + w, gridY)
          .stroke();
      fixed(fmt(minX + ((maxX - minX) * i) / 4), x + (i * w) / 4 - 12, y + h + 4);
      fixed(fmt(minY + ((maxY - minY) * i) / 4), left, gridY - 4);
    }
    series.forEach(({ points, name }, i) => {
      const color = i % 2 ? '#24548a' : '#a02b2b';
      doc.strokeColor(color).lineWidth(1.2);
      points
        .filter((p) => p.every(Number.isFinite))
        .forEach(([a, b], j) => {
          const px = x + ((a - minX) * w) / (maxX - minX || 1),
            py = y + h - ((b - minY) * h) / (maxY - minY || 1);
          if (j) doc.lineTo(px, py);
          else doc.moveTo(px, py);
        });
      doc.stroke().fillColor(color);
      fixed(name, x + i * 110, y + h + 34);
    });
    doc.fillColor('#16202b');
    fixed(xLabel, x, y + h + 19, w);
    doc.x = left;
    doc.y = y + h + 57;
  };
  try {
    title(t('SiCOPE 补充分析报告', 'SiCOPE Supplementary Analysis Report'));
    table(
      [
        t('样品信息', 'Sample information'),
        t('记录', 'Value'),
        t('分析条件', 'Analysis conditions'),
        t('记录', 'Value'),
      ],
      [
        [t('样品名称', 'Sample'), report.sample.name, t('分析口', 'Port'), report.sample.port],
        [
          t('样品质量', 'Mass'),
          `${fmt(report.sample.massG)} g`,
          t('实验气体', 'Gas'),
          report.sample.gas,
        ],
        [
          t('分析时间', 'Measurement'),
          report.sample.completedAt,
          t('浴温', 'Temperature'),
          `${fmt(report.sample.temperatureK)} K`,
        ],
        [
          t('吸附点数', 'Adsorption points'),
          report.branches.adsorption.length,
          t('脱附点数', 'Desorption points'),
          report.branches.desorption.length,
        ],
      ],
      [0.18, 0.34, 0.2, 0.28],
    );
    title(t('原报告概要', 'Original report summary'));
    if (report.summaryMetrics.length) {
      table(
        [t('分析项目', 'Metric'), t('数值', 'Value'), t('单位', 'Unit'), t('页码', 'Page')],
        report.summaryMetrics.map(({ label, value, unit, page }) => [label, value, unit, page]),
        [0.62, 0.17, 0.13, 0.08],
        [1, 3],
      );
    } else line(t('未提取到原报告摘要指标。', 'No original summary metrics were extracted.'));
    if (plan?.length) {
      title(t('补算项目与处理状态', 'Requested items and outcomes'));
      const labels = {
        bet: 'BET',
        bjh_adsorption: 'BJH 吸附支',
        bjh_desorption: 'BJH 脱附支',
        nldft: 'NLDFT',
      };
      for (const entry of plan) {
        const target = t(labels[entry.target], entry.target);
        if (entry.status !== 'calculate') {
          const statuses = {
            reported: '原报告已提供',
            blocked: '前置条件未满足',
            needs_model: '待确认模型核',
          };
          line(
            `${target}: ${t(statuses[entry.status], entry.status)}${entry.reason ? ` | ${diagnostic(entry.reason)}` : ''}`,
          );
          continue;
        }
        const matches = results.filter((result) => {
          if (entry.target === 'bet') return result.model === 'BET';
          if (entry.target === 'nldft') return result.model === 'NLDFT';
          return result.model === 'BJH' && entry.target === `bjh_${result.branch}`;
        });
        if (!matches.length) line(`${target}: ${t('未计算', 'not calculated')}`);
        for (const result of matches) {
          const name =
            result.model === 'NLDFT'
              ? 'kernel' in result
                ? result.kernel.modelId
                : result.modelId
              : undefined;
          const prefix = `${target}${name ? ` (${name})` : ''}`;
          if (result.error !== undefined)
            line(`${prefix}: ${t('计算失败', 'failed')} | ${diagnostic(result.error)}`);
          else if (result.model === 'NLDFT' && !result.converged)
            line(
              `${prefix}: ${t('仅供诊断 | 求解未收敛。', 'diagnostic only | Solver did not converge.')}`,
            );
          else if (result.model === 'BET' && result.status === 'invalid')
            line(
              `${prefix}: ${t('无效 | 没有有效的 BET 比表面积。', 'invalid | No valid BET area.')}`,
            );
          else line(`${prefix}: ${t('补算完成', 'calculated')}`);
        }
      }
    }
    title(t('补算结果概要', 'Supplementary results'));
    const summaryRows: Cells[] = [];
    for (const result of results) {
      const name =
        'kernel' in result && result.kernel
          ? `${result.model} ${result.kernel.modelId}`
          : `${result.model}${result.branch ? ` ${result.branch === 'adsorption' ? t('吸附支', 'Adsorption') : t('脱附支', 'Desorption')}` : ''}`;
      if (result.error !== undefined) {
        summaryRows.push([name, t('未完成', 'Failed'), diagnostic(result.error)]);
        continue;
      }
      if (result.model === 'BET')
        summaryRows.push([
          result.betsiEnabled ? 'BETSI' : name,
          result.status === 'ok'
            ? t('完成', 'Calculated')
            : result.status === 'invalid'
              ? t('无效', 'Invalid')
              : t('有诊断提示', 'See diagnostics'),
          `${t('比表面积', 'Area')} ${fmt(result.areaM2G)} m²/g · C = ${fmt(result.c)} · R² = ${fmt(result.rSquared)}`,
        ]);
      else
        summaryRows.push([
          name,
          result.model === 'NLDFT' && !result.converged
            ? t('仅供诊断', 'Diagnostic only')
            : t('完成', 'Calculated'),
          `${t('累计孔容', 'Pore volume')} ${fmt(result.totalPoreVolumeCm3G)} cm³/g${result.model === 'NLDFT' ? ` · RMSE ${fmt(result.rmse)}` : ` · ${t('累计面积', 'Area')} ${fmt(result.totalAreaM2G)} m²/g`}`,
        ]);
    }
    if (summaryRows.length)
      table(
        [t('分析项目', 'Model'), t('状态', 'Status'), t('结果 / 说明', 'Result / note')],
        summaryRows,
        [0.23, 0.2, 0.57],
      );
    for (const result of results) {
      signal?.throwIfAborted();
      if (result.error !== undefined) continue;
      doc.addPage();
      const branch =
        result.branch === 'adsorption' ? t('吸附支', 'Adsorption') : t('脱附支', 'Desorption');
      const modelName = result.model === 'BET' && result.betsiEnabled ? 'BETSI' : result.model;
      title(`${modelName} ${t('分析报告', 'Analysis Report')} · ${branch}`);
      const params: Cells[] = [
        [t('吸附质物性', 'Adsorptive properties'), result.properties.id],
        [t('计算点数', 'Fit points'), result.fitPointCount],
      ];
      if (result.model === 'BET') {
        params.push(
          [
            t('搜索相对压力', 'Search pressure range'),
            pressureRange(result.parameters.minPP0, result.parameters.maxPP0),
          ],
          [t('分子截面积 (nm²)', 'Cross sectional area (nm²)'), result.crossSectionNm2],
        );
        if (result.betsiEnabled) {
          const {
            method,
            selectedRange,
            minPoints,
            minRSquared,
            maxPressureErrorPercent,
            pressureErrorPercent,
          } = result.selection;
          params.push(
            [t('选点方法', 'Selection method'), method],
            [
              t('实际选点范围', 'Selected range'),
              pressureRange(selectedRange[0], selectedRange[1]),
            ],
            [
              t('筛选条件', 'Selection criteria'),
              `${minPoints} ${t('点', 'points')} · R² ≥ ${minRSquared} · ${t('偏差上限', 'Error cap')} ${maxPressureErrorPercent}%`,
            ],
            [t('单层压力偏差 (%)', 'Monolayer pressure error (%)'), pressureErrorPercent],
          );
        }
      } else if (result.model === 'BJH') {
        const p = result.parameters;
        params.push(
          [t('本支实测点数', 'Measured branch points'), result.measuredPointCount],
          [
            t('共享转折点', 'Shared turning point'),
            result.sharedTurningPoint ? t('是', 'Yes') : t('否', 'No'),
          ],
          [t('相对压力范围', 'Pressure range'), pressureRange(p.minPP0, p.maxPP0)],
          [
            t('孔径范围 (nm)', 'Pore diameter range (nm)'),
            pressureRange(p.minDiameterNm, p.maxDiameterNm),
          ],
          [t('厚度模型 / 修正', 'Thickness / correction'), `${p.thickness} / ${p.correction}`],
          [
            t('Kelvin 系数 (nm)', 'Kelvin factor (nm)'),
            `${fmt(p.kelvinFactorNm)} (${result.kelvinFactorSource})`,
          ],
          [
            t('密度换算 / 分数修正', 'Density factor / fraction'),
            `${fmt(p.densityConversionFactor)} / ${fmt(p.fraction)}`,
          ],
        );
      } else {
        params.push(
          [t('模型核 / 算法', 'Kernel / method'), `${result.kernel.modelId} / ${result.method}`],
          [
            t('相对压力范围', 'Pressure range'),
            pressureRange(result.options.minPP0, result.options.maxPP0),
          ],
          [t('正则化参数 λ', 'Regularization λ'), result.lambda],
          [t('是否收敛', 'Converged'), result.converged ? t('是', 'Yes') : t('否', 'No')],
        );
      }
      fields(params);
      if ('warnings' in result)
        for (const warning of result.warnings ?? []) line(diagnostic(warning));
      if ('areaM2G' in result && result.selected) {
        const points = [...result.selected].sort((a, b) => a.pp0 - b.pp0);
        const linear = points.map((p): [number, number] => [
          p.pp0,
          p.pp0 / (p.uptake * (1 - p.pp0)),
        ]);
        chart(
          [
            { name: t('实测', 'Measured'), points: linear },
            ...(result.slope != null && result.intercept != null
              ? [
                  {
                    name: t('拟合', 'Fit'),
                    points: points.map((p): [number, number] => [
                      p.pp0,
                      result.slope! * p.pp0 + result.intercept!,
                    ]),
                  },
                ]
              : []),
          ],
          'p/p0',
          t('BET 线性变换值', 'BET linearized uptake'),
        );
        table(
          [t('相对压力 p/p0', 'p/p0'), t('吸附量 cm³(STP)/g', 'Uptake cm³(STP)/g')],
          points.map((p) => [p.pp0, p.uptake]),
        );
      } else if ('kernel' in result && result.kernel && result.fit && result.distribution) {
        chart(
          [
            { name: t('实测', 'Measured'), points: result.fit.map((p) => [p.pp0, p.uptake]) },
            { name: t('拟合', 'Fit'), points: result.fit.map((p) => [p.pp0, p.fitted]) },
          ],
          'p/p0',
          t('吸附量 cm³(STP)/g', 'Uptake cm³(STP)/g'),
        );
        if (result.poreBands?.length)
          table(
            [
              t('孔宽下限 nm', 'Min nm'),
              t('孔宽上限 nm', 'Max nm'),
              t('分段孔容 cm³/g', 'Volume cm³/g'),
              t('累计孔容 cm³/g', 'Cumulative cm³/g'),
            ],
            result.poreBands.map((b) => [
              b.minWidthNm,
              b.maxWidthNm,
              b.volumeCm3G,
              b.cumulativeCm3G,
            ]),
          );
        chart(
          [
            {
              name: 'NLDFT',
              points: result.distribution.map((p) => [p.widthAngstrom / 10, p.poreVolumeCm3G]),
            },
          ],
          t('孔宽 nm', 'Pore width nm'),
          t('分箱孔容 cm³/g', 'Volume per bin cm³/g'),
        );
        table(
          [
            t('孔宽 nm', 'Width nm'),
            t('分箱孔容 cm³/g', 'Volume cm³/g'),
            t('累计孔容 cm³/g', 'Cumulative cm³/g'),
          ],
          result.distribution.map((p) => [
            p.widthAngstrom / 10,
            p.poreVolumeCm3G,
            p.cumulativeCm3G,
          ]),
        );
        title(t('等温线拟合明细', 'Isotherm fit details'));
        table(
          ['p/p0', t('实测值', 'Measured'), t('拟合值', 'Fitted'), t('残差', 'Residual')],
          result.fit.map((p) => [p.pp0, p.uptake, p.fitted, p.residual]),
        );
      } else if (result.model === 'BJH' && 'distribution' in result && result.distribution) {
        const bins = result.distribution;
        chart(
          [{ name: 'BJH', points: bins.map((p) => [p.diameterNm, p.dvDLogDiameter]) }],
          t('孔径 nm', 'Pore diameter nm'),
          'dV/dlogD cm³/g',
        );
        table(
          [
            t('压力下限 p/p0', 'p/p0 low'),
            t('孔径 nm', 'Diameter nm'),
            t('孔容 cm³/g', 'Volume cm³/g'),
            t('累计孔容 cm³/g', 'Cumulative cm³/g'),
            t('面积 m²/g', 'Area m²/g'),
          ],
          bins.map((p) => [p.lowPP0, p.diameterNm, p.poreVolumeCm3G, p.cumulativeCm3G, p.areaM2G]),
        );
      }
    }
    doc.addPage();
    title(t('计算记录', 'Calculation Trace'));
    if (report.sample.sam) line(`${t('原报告 SAM', 'Source SAM')}: ${report.sample.sam}`);
    line(`${t('原报告 PDF', 'Source PDF')} SHA-256: ${report.sha256}`);
    line(`${t('分支判定依据', 'Branch source')}: ${report.branchSource}`);
    for (const result of results) {
      if (result.error !== undefined) continue;
      line(`ADS ${result.properties.id} · SHA-256: ${result.properties.sha256}`);
      if (result.model === 'NLDFT')
        line(
          `${t('模型核', 'Kernel')} ${result.kernel.modelId} · SHA-256: ${result.kernel.sha256}`,
        );
    }
    const { start, count } = doc.bufferedPageRange();
    for (let i = start; i < start + count; i++) {
      doc.switchToPage(i);
      doc.strokeColor('#aab5bd').lineWidth(0.5).moveTo(left, 50).lineTo(right, 50).stroke();
      doc.fontSize(9).fillColor('#53606a');
      fixed(t('SiCOPE 补充分析', 'SiCOPE Supplementary Analysis'), left, 34);
      doc
        .strokeColor('#d7dfe5')
        .moveTo(left, bottom() + 9)
        .lineTo(right, bottom() + 9)
        .stroke();
      fixed(`${i - start + 1} / ${count}`, left, bottom() + 16, bodyWidth);
    }
    doc.end();
  } catch (error) {
    (doc as unknown as import('node:stream').Readable).destroy();
    void done.catch(() => {});
    throw error;
  }
  const bytes = await done;
  signal?.throwIfAborted();
  const output = join(dataDir, 'workspace', 'report-analysis');
  await mkdir(output, { recursive: true });
  const path = join(output, `sicope-supplement-${randomUUID()}.pdf`);
  await writeFile(path, bytes, { flag: 'wx' });
  return path;
}
