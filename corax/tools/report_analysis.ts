import { defineTool } from '@coraxjs/core/tools';
import { z } from 'zod';
import {
  calculateIsotherm,
  calculationOptionsSchema,
  isothermSchema,
} from '../lib/report-analysis';
import { modelIdSchema } from '../lib/report-analysis/contracts';
import { loadModel, modelIds, modelInfo } from '../lib/report-analysis/g12/models';
import { readReport } from '../lib/report-analysis/report/pdf';
import { loadAdsCatalog } from '../lib/report-analysis/g12/resources';
import { getRuntimeConfig } from '../lib/config';
import { planSupplement, supplementTarget } from '../lib/report-analysis/report/supplement';
import { exportSupplementPdf } from '../lib/report-analysis/report/export-pdf';

const reportOptions = {
  reportPath: z.string().min(1),
  expectedSamName: z.string().optional(),
  expectedPort: z.number().int().positive().optional(),
  adsorptionPointCount: z.number().int().min(0).optional(),
  exportPdf: z.boolean().optional(),
  reportLanguage: z
    .enum(['zh-CN', 'en'])
    .optional()
    .describe('补充 PDF 的语言。按用户明确要求选择；未指定时用中文。'),
  ...calculationOptionsSchema.shape,
};

export default defineTool({
  description:
    '离线分析 SiCOPE 报告。supplement 接收 targets，仅补算请求的缺失项目（显式 bet.betsi 可另外运行智能选点）；analyze 读取报告，可显式复算 bet、bjh、nldft；calculate 对结构化等温线独立计算。bet.betsi={} 启用智能选点；bjh 逐项指定吸附/脱附支。DFT 未指定核时用 supplement 查看候选，材料、孔形和分支未确认不要猜测；孔容分段直接使用 poreBands。PDF 未知分支时确认后再传 adsorptionPointCount。exportPdf 仅在用户要求导出补充报告时设 true，reportLanguage 按用户要求选 zh-CN 或 en，默认中文。list_ads/list_models/inspect_model 查询资源，get_points 分页取等温线。',
  inputSchema: z.discriminatedUnion('action', [
    z.object({ action: z.literal('inspect_model'), modelId: modelIdSchema }).strict(),
    z.object({ action: z.literal('list_models') }).strict(),
    z.object({ action: z.literal('list_ads') }).strict(),
    z
      .object({
        action: z.literal('calculate'),
        isotherm: isothermSchema,
        ...calculationOptionsSchema.shape,
      })
      .strict(),
    z
      .object({
        action: z.literal('get_points'),
        reportPath: z.string().min(1),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(40),
      })
      .strict(),
    z.object({ action: z.literal('analyze'), ...reportOptions }).strict(),
    z
      .object({
        action: z.literal('supplement'),
        targets: z.array(supplementTarget).min(1).max(4),
        ...reportOptions,
      })
      .strict(),
  ]),
  label: { start: () => '分析 SiCOPE 报告' },
  async execute(input, { abortSignal }) {
    if (input.action === 'list_ads') return JSON.stringify(await loadAdsCatalog());
    if (input.action === 'calculate') {
      if (!input.bet && !input.bjh && !input.nldft) throw new Error('请指定要计算的模型。');
      return JSON.stringify({
        gas: input.isotherm.gas,
        temperatureK: input.isotherm.temperatureK,
        results: await calculateIsotherm(input.isotherm, input, abortSignal),
      });
    }
    if (input.action === 'inspect_model')
      return JSON.stringify(modelInfo(await loadModel(input.modelId)));
    if (input.action === 'list_models') {
      const entries = [];
      for (const modelId of modelIds) {
        abortSignal?.throwIfAborted();
        entries.push(modelInfo(await loadModel(modelId)));
      }
      return JSON.stringify(entries);
    }

    const report = await readReport(input.reportPath, abortSignal);
    const {
      sample,
      summaryMetrics,
      points,
      branches,
      branchSource,
      rejectedRows,
      sha256,
      unverifiedUnitPages,
    } = report;
    if (input.action === 'get_points') {
      const end = input.offset + input.limit;
      return JSON.stringify({
        sample,
        reportSha256: sha256,
        branchSource,
        unverifiedUnitPages,
        total: points.length,
        nextOffset: end < points.length ? end : null,
        points: points.slice(input.offset, end),
      });
    }
    if (
      input.expectedSamName &&
      sample.sam?.split(/[\\/]/).at(-1)?.toLowerCase() !== input.expectedSamName.toLowerCase()
    )
      throw new Error('PDF 记录的 SAM 文件名与实验不符。');
    if (input.expectedPort !== undefined && sample.port !== String(input.expectedPort))
      throw new Error('PDF 记录的分析口与实验不符。');
    if (
      input.action === 'analyze' &&
      unverifiedUnitPages.length &&
      (input.bet || input.bjh || input.nldft)
    ) {
      throw new Error(
        `第 ${unverifiedUnitPages.join('、')} 页的等温线吸附量单位缺失或不受支持，不能复算。`,
      );
    }
    if (input.adsorptionPointCount !== undefined) {
      if (input.adsorptionPointCount > points.length)
        throw new Error('吸附点数超过等温线数据点总数。');
      branches.adsorption = points.slice(0, input.adsorptionPointCount);
      branches.desorption = points.slice(input.adsorptionPointCount);
    }
    const plan =
      input.action === 'supplement'
        ? await planSupplement(report, input.targets, input, abortSignal)
        : undefined;
    const options = plan?.options ?? input;
    const results =
      options.bet || options.bjh || options.nldft
        ? await calculateIsotherm(
            { ...sample, branches, uptakeUnit: 'cm3(STP)/g' },
            options,
            abortSignal,
          )
        : [];
    const branchLabel = input.adsorptionPointCount === undefined ? branchSource : 'user-confirmed';
    let supplementPdf: string | undefined;
    let exportError: string | undefined;
    if (input.exportPdf) {
      if (plan?.plan.length || results.some((result) => result.error === undefined)) {
        try {
          supplementPdf = await exportSupplementPdf(
            getRuntimeConfig().dataDir,
            { ...report, branchSource: branchLabel },
            results,
            abortSignal,
            plan?.plan,
            input.reportLanguage,
          );
        } catch (error) {
          abortSignal?.throwIfAborted();
          exportError = error instanceof Error ? error.message : '生成补充 PDF 失败。';
        }
      } else exportError = '没有已完成的补算结果，未生成补充 PDF。';
    }
    return JSON.stringify({
      sample,
      reportSha256: sha256,
      summaryMetrics,
      modelSections: report.modelSections,
      pointCount: points.length,
      rejectedRows,
      unverifiedUnitPages,
      branchSource: branchLabel,
      adsorptionCount: branches.adsorption.length,
      desorptionCount: branches.desorption.length,
      results,
      ...(plan && { supplementPlan: plan.plan }),
      ...(supplementPdf && {
        supplementPdf,
        artifacts: [{ path: supplementPdf, kind: 'file', label: '补充报告.pdf' }],
      }),
      ...(exportError && { exportError }),
    });
  },
});
