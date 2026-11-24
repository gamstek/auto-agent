import { z } from 'zod';
import type { CalculationOptions } from '../contracts';
import { modelIds, loadModel, modelInfo } from '../g12/models';
import { normalizeGas } from '../g12/resources';
import type { readReport } from './pdf';

export const supplementTarget = z.enum(['bet', 'bjh_adsorption', 'bjh_desorption', 'nldft']);
type Target = z.infer<typeof supplementTarget>;
type Report = Awaited<ReturnType<typeof readReport>>;
export type SupplementEntry = {
  target: Target;
  status: 'reported' | 'calculate' | 'blocked' | 'needs_model';
  reason?: string;
  candidates?: ReturnType<typeof modelInfo>[];
};

export async function planSupplement(
  report: Report,
  targets: Target[],
  requested: CalculationOptions,
  signal?: AbortSignal,
  projectRoot?: string,
) {
  const options: CalculationOptions = { adsId: requested.adsId };
  const plan: SupplementEntry[] = [];
  const reported = new Set<Target>(report.modelSections.map(({ model }) => model));
  for (const { label } of report.summaryMetrics) {
    if (/^BET\s*比表面积|^BET\s+surface area/i.test(label)) reported.add('bet');
    if (/^BJH\b.*吸附/.test(label)) reported.add('bjh_adsorption');
    if (/^BJH\b.*脱附/.test(label)) reported.add('bjh_desorption');
    if (/^(?:DFT|NLDFT|QSDFT)\b/i.test(label)) reported.add('nldft');
  }
  for (const target of new Set(targets)) {
    signal?.throwIfAborted();
    const wantsBetsi = target === 'bet' && requested.bet?.betsi !== undefined;
    const hasBetsi = report.modelSections.some(
      (section) => section.model === 'bet' && /智能选点|BETSI/i.test(section.heading),
    );
    if (reported.has(target) && (!wantsBetsi || hasBetsi)) {
      plan.push({ target, status: 'reported' });
      continue;
    }
    const required = target === 'bjh_desorption' ? 'desorption' : 'adsorption';
    const havePoints =
      target === 'nldft'
        ? report.branches.adsorption.length >= 3 || report.branches.desorption.length >= 3
        : report.branches[required].length >= (target === 'bet' ? 2 : 3);
    const reason = report.unverifiedUnitPages.length
      ? '等温线吸附量单位未得到验证。'
      : !report.sample.gas || !report.sample.temperatureK
        ? '报告缺少实验气体或温度。'
        : !havePoints
          ? report.branchSource === 'unknown'
            ? '等温线分支不明确，请先确认分界。'
            : '所需分支没有足够的等温线点。'
          : undefined;
    if (reason) {
      plan.push({ target, status: 'blocked', reason });
      continue;
    }
    if (target === 'nldft') {
      if (!requested.nldft?.length) {
        const candidates: ReturnType<typeof modelInfo>[] = [];
        for (const id of modelIds) {
          signal?.throwIfAborted();
          const kernel = await loadModel(id, projectRoot);
          if (
            kernel.gas !== normalizeGas(report.sample.gas!) ||
            Math.abs(kernel.temperatureK - report.sample.temperatureK!) > 1
          )
            continue;
          const branches = kernel.branch
            ? [kernel.branch]
            : (['adsorption', 'desorption'] as const);
          if (
            branches.some(
              (branch) =>
                report.branches[branch].filter(
                  (p) => p.pp0 >= kernel.pressures[0] && p.pp0 <= kernel.pressures.at(-1)!,
                ).length >= 3,
            )
          )
            candidates.push(modelInfo(kernel));
        }
        plan.push(
          candidates.length
            ? {
                target,
                status: 'needs_model',
                reason: '请按已确认的材料、孔形及分支选择模型核。',
                candidates,
              }
            : { target, status: 'blocked', reason: '没有匹配气体、温度和可用压力范围的内置核。' },
        );
        continue;
      }
      options.nldft = requested.nldft;
    } else if (target === 'bet') options.bet = requested.bet ?? {};
    else
      (options.bjh ??= []).push(
        requested.bjh?.find(({ branch }) => branch === required) ?? { branch: required },
      );
    plan.push({ target, status: 'calculate' });
  }
  return { options, plan };
}
