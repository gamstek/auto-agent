import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Branch, Point } from './kernel';

export type ReportPoint = Point & {
  pressureMmHg: number;
  saturationMmHg: number;
  elapsed: string;
  page: number;
};
export type SectionPage = { page: number; lines: string[] };

export async function readLocalFile(path: string, extension: string, limit: number) {
  if (!isAbsolute(path) || !path.toLowerCase().endsWith(extension)) {
    throw new Error(`请提供本机 ${extension} 文件的绝对路径。`);
  }
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      throw new Error('文件为空、过大或不是普通文件。');
    const data = new Uint8Array(stat.size);
    for (let offset = 0; offset < data.length;) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error('读取时文件发生变化，请重新选择报告或模型。');
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error('读取时文件发生变化，请重新选择报告或模型。');
    return data;
  } finally {
    await file.close();
  }
}

export async function readReport(path: string, signal?: AbortSignal) {
  const data = await readLocalFile(path, '.pdf', 32 * 1024 * 1024);
  const sha256 = createHash('sha256').update(data).digest('hex');
  // Let Node load PDF.js from its package so its worker and other assets stay adjacent.
  const entry = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const { getDocument }: typeof import('pdfjs-dist/legacy/build/pdf.mjs') = await import(
    pathToFileURL(entry).href
  );
  const task = getDocument({ data, useSystemFonts: false, stopAtErrors: true });
  const cancel = () => {
    void task.destroy().catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const doc = await task.promise;
    if (doc.numPages > 150) throw new Error('报告超过 150 页。');
    const pages: SectionPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      signal?.throwIfAborted();
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      if (content.items.length > 20_000) throw new Error('报告单页文字项过多。');
      const rows: { y: number; cells: { x: number; text: string }[] }[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, , , , x, y] = item.transform;
        let row = rows.find((r) => Math.abs(r.y - y) < 2);
        if (!row) rows.push((row = { y, cells: [] }));
        row.cells.push({ x, text: item.str.trim() });
      }
      pages.push({
        page: n,
        lines: rows
          .sort((a, b) => b.y - a.y)
          .map((r) =>
            r.cells
              .sort((a, b) => a.x - b.x)
              .map((c) => c.text)
              .join(' '),
          ),
      });
      page.cleanup();
    }
    return { ...parseReportPages(pages), sha256 };
  } finally {
    signal?.removeEventListener('abort', cancel);
    await task.destroy();
  }
}

const numeric = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const tableRow = new RegExp(
  `^(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+(\\d+:\\d{2})\\s+(${numeric})$`,
);
const field = (text: string, name: string) =>
  new RegExp(`${name}\\s*[：:]\\s*(.+)`).exec(text)?.[1]?.trim();

function uptakeUnitScale(headers: string[]) {
  const header = headers.join(' ').replace(/\s+/g, '').normalize('NFKC');
  if (/cm3\/gSTP|cm3\(STP\)\/g|cm3STP\/g/i.test(header)) return 1;
  if (/mmol\/g/i.test(header)) return 22.414;
  return null;
}

export function parseReportPages(pages: SectionPage[]) {
  const text = (pages[0]?.lines ?? []).join('\n');
  if (!/SiCOPE/i.test(text)) throw new Error('未识别到带文本层的 SiCOPE 报告。');
  const sam = /文件路径\s*[：:]\s*([^\n]+?(?:\n[^\n]+?)?\.SAM)\b/i
    .exec(text)?.[1]
    ?.replace(/\n\s*/g, '');
  const temperatureC = /测试温度\s*[：:]\s*(-?[\d.]+)\s*℃/.exec(text)?.[1];
  const mass = /样品质量\s*[：:]\s*([\d.]+)\s*g/.exec(text)?.[1];
  const gas = /测试气体\s*[：:]\s*(\S+)/.exec(text)?.[1]?.replace(/[₂]/g, '2').toUpperCase();
  const summary = pages.filter(
    ({ lines }) =>
      !lines.some((line) => /等温线|Horvath-Kawazoe 报告/.test(line)) &&
      lines.some((line) => /概要报告|^孔体积$|^孔径$/.test(line)),
  );
  const summaryMetrics = summary.flatMap(({ page, lines }) =>
    lines.flatMap((line, i) => {
      const metric = /^(.*?)\s*[：:]\s*([-+\d.eE]+)\s*(m[²2]\/g|cm[³3]\/g|Å)\s*$/.exec(line);
      if (!metric || !Number.isFinite(Number(metric[2]))) return [];
      const label = /^\(?孔径 <|^在 /.test(metric[1]) ? `${lines[i - 1]} ${metric[1]}` : metric[1];
      return [{ page, label, value: Number(metric[2]), unit: metric[3] }];
    }),
  );
  const points: ReportPoint[] = [];
  const unverifiedUnitPages: number[] = [];
  let rejectedRows = 0;
  for (const { lines, page } of pages) {
    if (!lines.some((line) => /等温线表格报告/.test(line))) continue;
    const firstRow = lines.findIndex((line) => tableRow.test(line));
    const scale = uptakeUnitScale(lines.slice(0, firstRow < 0 ? lines.length : firstRow));
    if (firstRow >= 0 && scale === null) unverifiedUnitPages.push(page);
    for (const line of lines) {
      const row = tableRow.exec(line);
      if (!row) {
        if (/\d+:\d{2}\s+[\d.]+$/.test(line)) rejectedRows++;
        continue;
      }
      const [, pp0, pressure, uptake, elapsed, saturation] = row;
      const values = [pp0, pressure, uptake, saturation].map(Number);
      if (
        scale === null ||
        values.some((n) => !Number.isFinite(n)) ||
        values[0] <= 0 ||
        values[1] <= 0 ||
        values[3] <= 0 ||
        Math.abs(values[0] - values[1] / values[3]) > Math.max(3e-7, 3e-6 * values[0])
      ) {
        rejectedRows++;
        continue;
      }
      points.push({
        pp0: values[0],
        pressureMmHg: values[1],
        uptake: values[2] * scale,
        elapsed,
        saturationMmHg: values[3],
        page,
      });
    }
  }
  const peak = points.reduce((index, p, i) => (p.pp0 > points[index].pp0 ? i : index), 0);
  const before = points.slice(0, peak + 1);
  const after = points.slice(peak + 1);
  const mentionsBranch = (label: string) =>
    pages.some(({ lines }) =>
      lines.some((line) =>
        new RegExp(`[:：]\\s*${label}(?=\\s|$)|^${label}(?:支|分支)?$`).test(line.trim()),
      ),
    );
  const hasAdsorption = mentionsBranch('吸附');
  const hasDesorption = mentionsBranch('脱附');
  const desorptionOnly =
    hasDesorption &&
    !hasAdsorption &&
    peak === 0 &&
    points.length > 1 &&
    points.every((point, i) => i === 0 || point.pp0 <= points[i - 1].pp0);
  const falling =
    hasAdsorption === hasDesorption &&
    peak > 0 &&
    after.length >= 3 &&
    after.every((p, i) => p.pp0 < (after[i - 1] ?? points[peak]).pp0) &&
    after[0].pp0 - after.at(-1)!.pp0 > 0.05 &&
    points[peak].pp0 > 0.5;
  const ambiguous =
    points.length > 0 && !desorptionOnly && !falling && (hasDesorption || after.length > 0);
  return {
    sample: {
      name: field(text, '样品名称'),
      sam,
      port: /分析口\s*(\d+)/.exec(text)?.[1],
      gas,
      massG: mass === undefined ? undefined : Number(mass),
      completedAt: /完成时间\s*[：:]\s*(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{2}:\d{2}:\d{2})/.exec(
        text,
      )?.[1],
      temperatureK:
        temperatureC === undefined
          ? undefined
          : Math.round((Number(temperatureC) + 273.15) * 1000) / 1000,
    },
    summaryMetrics,
    points,
    branches: {
      adsorption: ambiguous || desorptionOnly ? [] : before,
      desorption: desorptionOnly ? points : falling ? after : [],
    } satisfies Record<Branch, ReportPoint[]>,
    branchSource: desorptionOnly
      ? 'labeled-desorption'
      : ambiguous
        ? 'unknown'
        : falling
          ? 'sustained-pressure-reversal'
          : 'no-desorption-detected',
    rejectedRows,
    unverifiedUnitPages,
  };
}
