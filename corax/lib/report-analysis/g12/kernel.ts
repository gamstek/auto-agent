import { createHash } from 'node:crypto';

import { stpVolumePerMmol, type Point } from '../isotherm';
export type Kernel = ReturnType<typeof parseKernel>;

const gasTemperature = /^(N2|Ar|CO2|H2)\s*\(\s*(\d+(?:\.\d+)?)\s*K\s*\)/i;

export function parseKernel(bytes: Uint8Array) {
  const text = Uint8Array.from(bytes, (_, i) => bytes[bytes.length - 1 - i] ^ 71);
  const [header, ...lines] = new TextDecoder().decode(text).trim().split(/\r?\n/);
  const label = header.split(';', 1)[0];
  const spec = gasTemperature.exec(label);
  const invalid = () => new Error('不是受支持的 G12 .mod 模型，或模型矩阵不完整。');
  if (!spec || lines.length < 7) throw invalid();
  const rows = lines.map((line) =>
    line.split(',').map((token) => (token.trim() ? Number(token) : NaN)),
  );
  const [n, ...widths] = rows[0];
  const [m, ...transitionFlags] = rows[1];
  if (
    !Number.isInteger(n) ||
    n < 2 ||
    n > 256 ||
    !Number.isInteger(m) ||
    m < 2 ||
    m > 1000 ||
    widths.length !== n ||
    widths.some((w, i) => !Number.isFinite(w) || w <= (widths[i - 1] ?? 0)) ||
    (rows.length !== m + 5 && rows.length !== m + 6) ||
    rows.some(
      (row, i) => row.length !== (i === m + 5 ? n : n + 1) || row.some((x) => !Number.isFinite(x)),
    )
  )
    throw invalid();
  // In G12 the first column begins the pressure grid three rows before the response columns.
  const pressures = rows.slice(2, m + 2).map((row) => row[0]);
  if (pressures.some((p, i) => p <= 0 || p < (pressures[i - 1] ?? 0))) throw invalid();
  const curves = widths.map((_, j) => {
    const samples = pressures.flatMap((p, i) =>
      p === pressures[i - 1] ? [] : [{ pp0: p, uptake: rows[i + 5][j + 1] }],
    );
    const jump = rows[2][j + 1];
    const makeSegment = (segment: Point[]) => {
      if (segment.some((point) => point.uptake < 0)) throw invalid();
      return segment;
    };
    if (!transitionFlags[j] || jump <= pressures[0] || jump >= pressures.at(-1)!) {
      return { jump: null, left: makeSegment(samples), right: [] };
    }
    return {
      jump,
      left: makeSegment([
        ...samples.filter((p) => p.pp0 < jump),
        { pp0: jump, uptake: rows[3][j + 1] },
      ]),
      right: makeSegment([
        { pp0: jump, uptake: rows[4][j + 1] },
        ...samples.filter((p) => p.pp0 > jump),
      ]),
    };
  });
  return {
    label,
    gas: spec[1].toUpperCase(),
    temperatureK: Number(spec[2]),
    branch: /\bDES\b/i.test(label)
      ? ('desorption' as const)
      : /\bADS\b/i.test(label)
        ? ('adsorption' as const)
        : null,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    widths,
    pressures,
    curves,
    geometryCodes: rows[m + 5] ?? null,
  };
}

export function kernelResponse(kernel: Kernel, pressure: number) {
  if (!(pressure >= kernel.pressures[0] && pressure <= kernel.pressures.at(-1)!)) {
    throw new Error('相对压力超出模型核范围。');
  }
  return kernel.curves.map(({ jump, left, right }) => {
    const points = jump !== null && pressure >= jump ? right : left;
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].pp0 <= pressure) lo = mid;
      else hi = mid;
    }
    const a = points[lo];
    const b = points[hi];
    const f = lo === hi ? 0 : Math.log(pressure / a.pp0) / Math.log(b.pp0 / a.pp0);
    // G12 converts kernel density to STP uptake per cm³ of pore volume.
    return stpVolumePerMmol * (a.uptake + f * (b.uptake - a.uptake));
  });
}
