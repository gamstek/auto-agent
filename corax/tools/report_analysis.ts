import { defineTool } from '@coraxjs/core/tools';
import { z } from 'zod';
import { fitBet } from '../lib/report-analysis/bet';
import { loadModel, modelIds } from '../lib/report-analysis/models';
import { fitNldft } from '../lib/report-analysis/nldft';
import { readReport } from '../lib/report-analysis/pdf';

const pressure = z.number().min(0).max(1.1);
const modelIdSchema = z.enum(modelIds);
const nldft = z
  .object({
    modelId: modelIdSchema,
    branch: z.enum(['adsorption', 'desorption']).optional(),
    minPP0: pressure.optional(),
    maxPP0: pressure.optional(),
    lambda: z.number().min(0).max(1000).optional(),
  })
  .strict();

export default defineTool({
  description:
    '离线解析本机 SiCOPE PDF 并复算 BET、NLDFT。先用 reportPath 查看样品、原报告指标和等温线分支；可给 bet 选点范围，或给 nldft 指定一个或多个内置 G12 模型 ID 求解孔容贡献、重建等温线。list_models 列出内置核，inspect_model 按 modelId 查看核信息。根据用户确认的材料、孔形、气体、温度和分支选核，不从样品名猜测；未知分支时，仅在用户确认后传 adsorptionPointCount（等温线表从首行到吸附末行的有效点数）。get_points 分页取等温线。PDF 中的结果是原报告结果，求解结果是独立复算。',
  inputSchema: z.discriminatedUnion('action', [
    z.object({ action: z.literal('inspect_model'), modelId: modelIdSchema }).strict(),
    z.object({ action: z.literal('list_models') }).strict(),
    z
      .object({
        action: z.literal('get_points'),
        reportPath: z.string().min(1),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(40),
      })
      .strict(),
    z
      .object({
        action: z.literal('analyze'),
        reportPath: z.string().min(1),
        expectedSamName: z.string().optional(),
        expectedPort: z.number().int().positive().optional(),
        adsorptionPointCount: z.number().int().min(0).optional(),
        bet: z
          .object({
            minPP0: pressure.optional(),
            maxPP0: pressure.optional(),
            crossSectionNm2: z.number().positive().max(10).optional(),
          })
          .strict()
          .optional(),
        nldft: z.array(nldft).min(1).max(4).optional(),
      })
      .strict(),
  ]),
  label: { start: () => '分析 SiCOPE 报告' },
  async execute(input, { abortSignal }) {
    const modelInfo = ({
      modelId,
      label,
      gas,
      temperatureK,
      branch,
      sha256,
      widths,
      pressures,
    }: Awaited<ReturnType<typeof loadModel>>) => ({
      modelId,
      label,
      gas,
      temperatureK,
      branch,
      sha256,
      binCount: widths.length,
      poreWidthRangeAngstrom: [widths[0], widths.at(-1)],
      pressureRange: [pressures[0], pressures.at(-1)],
    });
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

    const {
      sample,
      summaryMetrics,
      points,
      branches,
      branchSource,
      rejectedRows,
      sha256,
      unverifiedUnitPages,
    } = await readReport(input.reportPath, abortSignal);
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
    if (unverifiedUnitPages.length && (input.bet || input.nldft)) {
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
    const results = [];
    if (input.bet) {
      try {
        if (sample.gas !== 'N2' && input.bet.crossSectionNm2 === undefined)
          throw new Error('非氮气报告需要指定气体分子横截面积（nm²）。');
        results.push({
          model: 'BET',
          ...fitBet(
            branches.adsorption,
            input.bet.minPP0,
            input.bet.maxPP0,
            input.bet.crossSectionNm2,
          ),
        });
      } catch (error) {
        results.push({ model: 'BET', error: (error as Error).message });
      }
    }
    for (const { modelId, branch, ...options } of input.nldft ?? []) {
      abortSignal?.throwIfAborted();
      try {
        const kernel = await loadModel(modelId);
        const selected = branch ?? kernel.branch ?? 'adsorption';
        if (kernel.branch && branch && kernel.branch !== branch)
          throw new Error('选定的分支与模型文件标明的分支不一致。');
        if (
          kernel.gas !== sample.gas ||
          sample.temperatureK === undefined ||
          Math.abs(kernel.temperatureK - sample.temperatureK) > 1
        )
          throw new Error('报告中的气体或温度与模型核不匹配。');
        if (!branches[selected].length)
          throw new Error('没有可计算的该分支数据，请确认等温线表及分支。');
        results.push({
          model: 'NLDFT',
          kernel: modelInfo(kernel),
          branch: selected,
          options,
          ...(await fitNldft(kernel, branches[selected], { ...options, signal: abortSignal })),
        });
      } catch (error) {
        abortSignal?.throwIfAborted();
        results.push({ model: 'NLDFT', modelId, error: (error as Error).message });
      }
    }
    return JSON.stringify({
      sample,
      reportSha256: sha256,
      summaryMetrics,
      pointCount: points.length,
      rejectedRows,
      unverifiedUnitPages,
      branchSource: input.adsorptionPointCount === undefined ? branchSource : 'user-confirmed',
      adsorptionCount: branches.adsorption.length,
      desorptionCount: branches.desorption.length,
      results,
    });
  },
});
