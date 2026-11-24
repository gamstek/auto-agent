import type { Branch, Point } from '../isotherm';

type Thickness = 'harkins-jura' | 'halsey';
export type BjhParameters = {
  branch: Branch;
  minPP0?: number;
  maxPP0?: number;
  minDiameterNm?: number;
  maxDiameterNm?: number;
  thickness?: Thickness;
  correction?: 'standard' | 'kjs';
  fraction?: number;
  kelvinFactorNm?: number;
};

export function fitBjh(
  points: Point[],
  parameters: BjhParameters,
  density: number,
  kelvinFactorNm: number,
  adsorptionTurningPoint?: Point,
) {
  const {
    branch,
    minPP0 = 0.1,
    maxPP0 = 0.995,
    minDiameterNm = 1.7,
    maxDiameterNm = 300,
    thickness = 'harkins-jura',
    correction = 'standard',
    fraction = 0,
  } = parameters;
  if (!(minPP0 < maxPP0 && maxPP0 < 1 && minDiameterNm < maxDiameterNm))
    throw new Error('BJH 相对压力或孔径范围无效。');
  if (!(density > 0 && kelvinFactorNm > 0))
    throw new Error('BJH 需要正的液体体积换算系数及 Kelvin 系数。');
  if (branch === 'desorption' && fraction !== 0) throw new Error('BJH 分数修正仅用于吸附支。');
  const selected = points
    .filter(({ pp0, uptake }) => pp0 > 0 && pp0 >= minPP0 && pp0 <= maxPP0 && uptake >= 0)
    .sort((a, b) => b.pp0 - a.pp0);
  if (selected.length < 3) throw new Error('BJH 需要所选分支和压力范围内至少三个实测有效点。');
  if (selected.some((point, i) => i && point.pp0 === selected[i - 1].pp0))
    throw new Error('BJH 压力范围内有重复相对压力点，请确认选点。');
  const measuredPointCount = selected.length;
  const sharedTurningPoint =
    branch === 'desorption' &&
    adsorptionTurningPoint !== undefined &&
    adsorptionTurningPoint.pp0 > selected[0].pp0 &&
    adsorptionTurningPoint.pp0 <= maxPP0;

  // Check the actual measurements before inserting the shared starting point.
  let reversedSteps = 0;
  let reversedUptake = 0;
  const checkTrend = (rows: Point[]) => {
    const peakUptake = Math.max(...rows.map(({ uptake }) => uptake));
    reversedSteps = 0;
    reversedUptake = 0;
    for (let i = 1; i < rows.length; i++) {
      const rise = rows[i].uptake - rows[i - 1].uptake;
      if (rise > 0) {
        reversedSteps++;
        reversedUptake += rise;
      }
    }
    const branchName = branch === 'desorption' ? '脱附' : '吸附';
    if (rows[0].uptake <= rows.at(-1)!.uptake)
      throw new Error(`BJH ${branchName}支的高压端吸附量不大于低压端，请核对分支和数据。`);
    if (reversedUptake > peakUptake * 0.01)
      throw new Error(
        `BJH ${branchName}支累计反向吸附量超过该区间最大吸附量的 1%，请核对分支和数据。`,
      );
  };
  checkTrend(selected);
  if (sharedTurningPoint) {
    selected.unshift(adsorptionTurningPoint);
    checkTrend(selected);
  }
  const film = (p: number) =>
    thickness === 'halsey'
      ? 0.354 * (-5 / Math.log(p)) ** (1 / 3)
      : Math.sqrt(13.99 / (0.034 - Math.log10(p))) / 10;
  const offset = correction === 'kjs' ? 0.3 : 0;
  const effectiveFactor = kelvinFactorNm / (1 + fraction);
  const rows = selected.map((p) => ({
    ...p,
    t: film(p.pp0),
    rk: -effectiveFactor / Math.log(p.pp0) + offset,
  }));
  const bins: {
    highPP0: number;
    lowPP0: number;
    diameterNm: number;
    poreVolumeCm3G: number;
    areaM2G: number;
    dvDLogDiameter: number;
  }[] = [];
  let skippedSteps = 0;
  let before = rows[0];
  for (const curr of rows.slice(1)) {
    const measured = density * (before.uptake - curr.uptake);
    const dt = before.t - curr.t;
    const filmLoss = bins.reduce((sum, bin) => {
      const radius = bin.diameterNm / 2;
      return (
        sum +
        (bin.poreVolumeCm3G * ((radius - curr.t) ** 2 - (radius - before.t) ** 2)) / radius ** 2
      );
    }, 0);
    const condensed = measured - filmLoss;
    if (!(condensed > 0 && dt > 0)) {
      skippedSteps++;
      // On adsorption let the next point account for the unallocated step.
      if (branch === 'desorption') before = curr;
      continue;
    }
    // Standard/KJS Kelvin weighting and film correction follow the G12 equations.
    const core = ((before.rk + curr.rk) * before.rk * curr.rk) / (before.rk ** 2 + curr.rk ** 2);
    const p = Math.exp(-effectiveFactor / (core - offset));
    const radius = core + film(p);
    const diameterNm = 2 * radius;
    const poreVolumeCm3G = condensed * (radius / core) ** 2;
    const areaM2G = (4000 * poreVolumeCm3G) / diameterNm;
    const dvDLogDiameter = poreVolumeCm3G / Math.log10((before.rk + before.t) / (curr.rk + curr.t));
    if (
      ![diameterNm, poreVolumeCm3G, areaM2G, dvDLogDiameter].every(
        (v) => Number.isFinite(v) && v > 0,
      )
    )
      throw new Error('BJH 孔径或体积计算无效。');
    bins.push({
      highPP0: before.pp0,
      lowPP0: curr.pp0,
      diameterNm,
      poreVolumeCm3G,
      areaM2G,
      dvDLogDiameter,
    });
    before = curr;
  }
  let totalPoreVolumeCm3G = 0,
    totalAreaM2G = 0;
  const distribution = bins
    .filter((bin) => bin.diameterNm >= minDiameterNm && bin.diameterNm <= maxDiameterNm)
    .sort((a, b) => a.diameterNm - b.diameterNm)
    .map((bin) => ({
      ...bin,
      cumulativeCm3G: (totalPoreVolumeCm3G += bin.poreVolumeCm3G),
      cumulativeAreaM2G: (totalAreaM2G += bin.areaM2G),
    }));
  if (!distribution.length) throw new Error('所选 BJH 孔径范围未得到有效的正孔容分布。');
  return {
    method: 'g12-bjh-cylindrical-v1',
    parameters: {
      branch,
      minPP0,
      maxPP0,
      minDiameterNm,
      maxDiameterNm,
      thickness,
      correction,
      fraction,
      kelvinFactorNm,
      densityConversionFactor: density,
    },
    fitPointCount: selected.length,
    measuredPointCount,
    sharedTurningPoint,
    actualPressureRange: [selected.at(-1)!.pp0, selected[0].pp0],
    skippedSteps,
    reversedSteps,
    totalPoreVolumeCm3G,
    totalAreaM2G,
    distribution,
    warnings: [
      'BJH 使用圆柱孔 Kelvin 模型，不用于定量解释微孔。',
      ...(reversedSteps
        ? [
            `${reversedSteps} 个压力间隔有小幅反向波动；累计反向吸附量为 ${Number(reversedUptake.toPrecision(4))} cm³(STP)/g。`,
          ]
        : []),
      ...(skippedSteps ? [`${skippedSteps} 个压力间隔未产生可分配的正孔容。`] : []),
    ],
  };
}
