import type { Point } from '../isotherm';

export function fitBet(points: Point[], minPP0 = 0.045, maxPP0 = 0.31, crossSectionNm2 = 0.162) {
  const selected = points.filter(
    (p) => p.pp0 >= minPP0 && p.pp0 <= maxPP0 && p.pp0 > 0 && p.pp0 < 1 && p.uptake > 0,
  );
  if (new Set(selected.map((p) => p.pp0)).size < 2)
    throw new Error('BET 拟合区间内至少需要两个不同压力点。');
  const xy = selected.map(({ pp0, uptake }) => [pp0, pp0 / (uptake * (1 - pp0))]);
  const mx = xy.reduce((sum, [x]) => sum + x, 0) / xy.length;
  const my = xy.reduce((sum, [, y]) => sum + y, 0) / xy.length;
  const slope =
    xy.reduce((sum, [x, y]) => sum + (x - mx) * (y - my), 0) /
    xy.reduce((sum, [x]) => sum + (x - mx) ** 2, 0);
  const intercept = my - slope * mx;
  const qm = 1 / (intercept + slope);
  const c = 1 / (intercept * qm);
  const ss = xy.reduce((sum, [, y]) => sum + (y - my) ** 2, 0);
  const rSquared = ss
    ? 1 - xy.reduce((sum, [x, y]) => sum + (y - intercept - slope * x) ** 2, 0) / ss
    : null;
  const warnings: string[] = [];
  const positiveFinite = (value: number) => value > 0 && Number.isFinite(value);
  const finiteOrNull = (value: number) => (Number.isFinite(value) ? value : null);
  const area = qm * ((6.02214076e23 * crossSectionNm2) / 2.2414e22);
  const areaM2G = positiveFinite(qm) && positiveFinite(area) ? area : null;
  if (selected.length === 2) warnings.push('只有两个拟合点，R² 不能用于判断拟合可靠性。');
  if (!positiveFinite(c)) warnings.push('BET 常数 C 不为有限正值。');
  if (!positiveFinite(qm)) warnings.push('单层吸附量不为有限正值。');
  else if (areaM2G === null) warnings.push('BET 比表面积超出可计算范围。');
  const ordered = [...selected].sort((a, b) => a.pp0 - b.pp0);
  if (
    ordered.some(
      (p, i) => i > 0 && p.uptake * (1 - p.pp0) < ordered[i - 1].uptake * (1 - ordered[i - 1].pp0),
    )
  )
    warnings.push('q(1−p/p₀) 在拟合区间内并非单调不减。');
  const monolayerPP0 = c > 0 && Number.isFinite(c) ? 1 / (1 + Math.sqrt(c)) : null;
  if (
    monolayerPP0 !== null &&
    (monolayerPP0 < ordered[0].pp0 || monolayerPP0 > ordered.at(-1)!.pp0)
  )
    warnings.push('模型给出的单层压力在实际选点范围之外。');
  return {
    status: areaM2G === null ? 'invalid' : warnings.length ? 'warning' : 'ok',
    areaM2G,
    crossSectionNm2,
    qm: finiteOrNull(qm),
    c: finiteOrNull(c),
    slope: finiteOrNull(slope),
    intercept: finiteOrNull(intercept),
    rSquared: rSquared === null ? null : finiteOrNull(rSquared),
    fitPointCount: selected.length,
    betsiEnabled: false as const,
    monolayerPP0,
    selected,
    warnings,
  };
}
