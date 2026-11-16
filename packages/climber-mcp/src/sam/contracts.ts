import { z } from 'zod';

export const samFileInput = z
  .object({
    operation: z.enum(['profiles', 'inspect', 'compare', 'create', 'modify', 'save-as']),
    input: z
      .record(z.string(), z.unknown())
      .describe(
        '操作参数对象。product 沿用 SAM 标识：g5 对应 Climber（研发别称 G5），g12 对应 SiCOPE（研发别称 G12）；G5/G12 不是另外两款仪器。profiles: {} 或 {product}；inspect: {path,product}；compare: {path,product,requirements,tolerances?}；create: {product,settings,path?,profile?} 或 {path,product,template}；modify: {path,product,expectedSha256,changes?,reportTypes?,summaryReport?}；save-as: {path,sourcePath,product,expectedSha256,changes?,reportTypes?,summaryReport?}。settings.analysisType：Climber 支持 bet/mesopore；SiCOPE 支持 bet/mesopore/micropore。勾选概要报告的新建 settings 须提供 summaryReport:{enabledFields,adsorptionPoresAtPP0,desorptionPoresAtPP0}；enabledFields 是完整的原生开关列表，两个阈值为 P/P0。reportTypes 仅控制报告整体选择；概要子项须按文档显式填写，再用 inspect 的 summaryReport 和 compare 的 requirements.summaryReport 核对。create 的显式 settings 覆盖对应底座默认参数；profiles 选择产品/版本配置，不匹配材料或文档模板名称。产品、单位、原生开关名和写入细节见 device-automation 的 SAM 参考文档。',
      ),
  })
  .strict();

export type SamFileInput = z.infer<typeof samFileInput>;
export const samWrites = new Set<SamFileInput['operation']>(['create', 'modify', 'save-as']);
