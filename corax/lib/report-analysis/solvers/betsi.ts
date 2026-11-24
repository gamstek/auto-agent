import type { Point } from '../isotherm';
import { fitBet } from './bet';

export type BetsiSettings = {
  minPoints?: number;
  minRSquared?: number;
  maxPressureErrorPercent?: number;
};

/** BETSI window ranking (latest valid endpoint, then lowest monolayer pressure error).
 * Measured monolayer pressure is interpolated linearly within the selected points. */
export function selectBetWindow(
  points: Point[],
  minPP0: number,
  maxPP0: number,
  crossSection: number,
  { minPoints = 5, minRSquared = 0.995, maxPressureErrorPercent = 20 }: BetsiSettings = {},
  signal?: AbortSignal,
) {
  const rows = points
    .filter((p) => p.pp0 >= minPP0 && p.pp0 <= maxPP0 && p.pp0 > 0 && p.pp0 < 1 && p.uptake > 0)
    .sort((a, b) => a.pp0 - b.pp0);
  if (rows.length > 2000) throw new Error('BETSI 搜索范围超过 2000 点，请缩小压力范围。');
  if (rows.some((p, i) => i && p.pp0 === rows[i - 1].pp0))
    throw new Error('BETSI 搜索范围含重复相对压力点，请先确认选点。');
  let best:
    | { start: number; end: number; pressureErrorPercent: number; measuredMonolayerPP0: number }
    | undefined;
  let eligibleWindows = 0;
  for (let i = 0; i <= rows.length - minPoints; i++) {
    signal?.throwIfAborted();
    let mx = 0,
      my = 0,
      xx = 0,
      yy = 0,
      xy = 0,
      previousY = -Infinity,
      previousRouquerol = -Infinity;
    for (let j = i; j < rows.length; j++) {
      const { pp0, uptake } = rows[j];
      const rouquerol = uptake * (1 - pp0);
      const y = pp0 / rouquerol;
      if (!(Number.isFinite(y) && rouquerol >= previousRouquerol && y >= previousY)) break;
      previousY = y;
      previousRouquerol = rouquerol;
      const count = j - i + 1;
      const dx = pp0 - mx;
      const dy = y - my;
      mx += dx / count;
      my += dy / count;
      xx += dx * (pp0 - mx);
      yy += dy * (y - my);
      xy += dx * (y - my);
      if (count < minPoints || !(xx > 0 && yy > 0 && (xy * xy) / (xx * yy) >= minRSquared))
        continue;
      const slope = xy / xx;
      const intercept = my - slope * mx;
      const qm = 1 / (slope + intercept);
      const c = 1 / (intercept * qm);
      if (!(c > 0 && Number.isFinite(c) && qm > rows[i].uptake && qm < uptake)) continue;
      let lo = i,
        hi = j;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (rows[mid].uptake < qm) lo = mid;
        else hi = mid;
      }
      const a = rows[lo],
        b = rows[hi];
      const measuredMonolayerPP0 =
        a.pp0 + (b.pp0 - a.pp0) * ((qm - a.uptake) / (b.uptake - a.uptake));
      const calculated = 1 / (1 + Math.sqrt(c));
      const pressureErrorPercent =
        (100 * Math.abs(calculated - measuredMonolayerPP0)) / measuredMonolayerPP0;
      if (!(pressureErrorPercent <= maxPressureErrorPercent)) continue;
      eligibleWindows++;
      if (
        !best ||
        j > best.end ||
        (j === best.end && pressureErrorPercent < best.pressureErrorPercent)
      ) {
        best = { start: i, end: j, pressureErrorPercent, measuredMonolayerPP0 };
      }
    }
  }
  if (!best)
    throw new Error(
      `BETSI 未找到满足条件的窗口（${rows.length} 个可用点；至少 ${minPoints} 点、R² ≥ ${minRSquared}、单层压力偏差 ≤ ${maxPressureErrorPercent}%）。`,
    );
  const selected = rows.slice(best.start, best.end + 1);
  const result = fitBet(selected, selected[0].pp0, selected.at(-1)!.pp0, crossSection);
  if (result.areaM2G === null || result.c === null || result.c <= 0)
    throw new Error('BETSI 所选窗口复核未通过。');
  return {
    ...result,
    betsiEnabled: true as const,
    selection: {
      method: 'betsi-linear-v1',
      minPoints,
      minRSquared,
      maxPressureErrorPercent,
      eligibleWindows,
      selectedRange: [selected[0].pp0, selected.at(-1)!.pp0],
      measuredMonolayerPP0: best.measuredMonolayerPP0,
      pressureErrorPercent: best.pressureErrorPercent,
    },
  };
}
