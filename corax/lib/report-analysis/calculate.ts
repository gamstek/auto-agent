import {
  calculationInputSchema,
  calculationOptionsSchema,
  type CalculationOptions,
} from './contracts';
import { stpVolumePerMmol, type Branch, type Isotherm } from './isotherm';
import { loadModel, modelInfo } from './g12/models';
import { normalizeGas, selectAds } from './g12/resources';
import { fitBet } from './solvers/bet';
import { fitNldft } from './solvers/nldft';
import { selectBetWindow } from './solvers/betsi';
import { fitBjh } from './solvers/bjh';
import { sumPoreBands } from './solvers/pore-bands';

function assertRange(min?: number, max?: number) {
  if (min !== undefined && max !== undefined && min >= max)
    throw new Error('起始相对压力必须小于结束相对压力。');
}

/** Shared calculation entry point for parsed reports and structured isotherms. */
export async function calculateIsotherm(
  data: Isotherm,
  options: CalculationOptions,
  signal?: AbortSignal,
  projectRoot?: string,
) {
  const {
    gas: suppliedGas,
    temperatureK: temperature,
    branches,
    uptakeUnit,
  } = calculationInputSchema.parse(data);
  const { bet, bjh, nldft, adsId } = calculationOptionsSchema.parse(options);
  if (!bet && !bjh && !nldft) return [];
  const results = [];
  const gas = normalizeGas(suppliedGas);
  signal?.throwIfAborted();
  const properties = await selectAds(gas, temperature, adsId, projectRoot);
  const pointsFor = (branch: Branch) => {
    const points = branches[branch];
    if (!points.length)
      throw new Error(
        `没有可计算的${branch === 'adsorption' ? '吸附' : '脱附'}支数据，请确认分支。`,
      );
    if (uptakeUnit !== 'mmol/g') return points;
    return points.map((point) => {
      const uptake = point.uptake * stpVolumePerMmol;
      if (!Number.isFinite(uptake)) throw new Error('吸附量换算后超出可计算范围。');
      return { ...point, uptake };
    });
  };
  if (bet) {
    try {
      const { betsi, minPP0 = betsi ? 0 : 0.045, maxPP0 = betsi ? 1 : 0.31, crossSectionNm2 } = bet;
      assertRange(minPP0, maxPP0);
      const area = crossSectionNm2 ?? properties.crossSectionNm2;
      if (area <= 0) throw new Error('该 .ADS 未提供有效的 BET 分子横截面积。');
      results.push({
        model: 'BET' as const,
        branch: 'adsorption',
        parameters: {
          minPP0,
          maxPP0,
          crossSectionSource: crossSectionNm2 === undefined ? 'ads' : 'override',
        },
        properties,
        ...(betsi
          ? selectBetWindow(pointsFor('adsorption'), minPP0, maxPP0, area, betsi, signal)
          : fitBet(pointsFor('adsorption'), minPP0, maxPP0, area)),
      });
    } catch (error) {
      signal?.throwIfAborted();
      results.push({
        model: 'BET' as const,
        betsiEnabled: !!bet.betsi,
        error: (error as Error).message,
      });
    }
  }
  for (const spec of bjh ?? []) {
    signal?.throwIfAborted();
    try {
      const points = pointsFor(spec.branch);
      // SiCOPE starts the desorption calculation from the adsorption turning point.
      // Require real desorption measurements first; the shared point is not a substitute.
      const turningPoint =
        spec.branch === 'desorption' && branches.adsorption.length
          ? pointsFor('adsorption').reduce((a, b) => (a.pp0 >= b.pp0 ? a : b))
          : undefined;
      const factor = properties.bjhAdsorbateFactorAngstrom[spec.branch];
      // G12's standard nitrogen fallback when the native property is absent or zero.
      const fallback = gas === 'N2' && Math.abs(temperature - 77.35) <= 1 ? 0.953 : undefined;
      const kelvin = spec.kelvinFactorNm ?? (factor && factor > 0 ? factor / 10 : fallback);
      if (!kelvin)
        throw new Error('所选 .ADS 缺少有效的本分支 BJH 系数，请提供已确认的 kelvinFactorNm。');
      results.push({
        model: 'BJH' as const,
        branch: spec.branch,
        properties,
        kelvinFactorSource:
          spec.kelvinFactorNm !== undefined
            ? 'override'
            : factor && factor > 0
              ? 'ads'
              : 'g12-nitrogen-default',
        ...fitBjh(points, spec, properties.densityConversionFactor, kelvin, turningPoint),
      });
    } catch (error) {
      results.push({ model: 'BJH' as const, branch: spec.branch, error: (error as Error).message });
    }
  }
  for (const { modelId, branch, poreWidthEdgesNm, ...parameters } of nldft ?? []) {
    signal?.throwIfAborted();
    try {
      assertRange(parameters.minPP0, parameters.maxPP0);
      const kernel = await loadModel(modelId, projectRoot);
      if (kernel.gas !== gas || Math.abs(kernel.temperatureK - temperature) > 1)
        throw new Error('实验气体或温度与模型核不匹配。');
      if (kernel.branch && branch && kernel.branch !== branch)
        throw new Error('选定的分支与模型文件标明的分支不一致。');
      const selected = branch ?? kernel.branch ?? 'adsorption';
      const fit = await fitNldft(kernel, pointsFor(selected), { ...parameters, signal });
      results.push({
        model: 'NLDFT' as const,
        kernel: modelInfo(kernel),
        branch: selected,
        options: parameters,
        properties,
        fitPointCount: fit.fit.length,
        poreBands: fit.converged ? sumPoreBands(fit.distribution, poreWidthEdgesNm) : [],
        ...fit,
      });
    } catch (error) {
      signal?.throwIfAborted();
      results.push({ model: 'NLDFT' as const, modelId, error: (error as Error).message });
    }
  }
  return results;
}
