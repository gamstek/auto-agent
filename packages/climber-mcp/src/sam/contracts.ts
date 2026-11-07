import { z } from 'zod';

export const samFileInput = z
  .object({
    operation: z.enum(['profiles', 'inspect', 'compare', 'create', 'modify', 'save-as']),
    input: z
      .record(z.string(), z.unknown())
      .describe(
        '操作参数对象。product 沿用 SAM 标识：g5 对应 Climber（研发别称 G5），g12 对应 SiCOPE（研发别称 G12）；G5/G12 不是另外两款仪器。profiles: {} 或 {product}；inspect: {path,product}；compare: {path,product,requirements,tolerances?}；create: {product,settings,path?,profile?} 或 {path,product,template}；modify: {path,product,expectedSha256,changes?,reportTypes?}；save-as: {path,sourcePath,product,expectedSha256,changes?,reportTypes?}。create 的显式 settings 覆盖对应底座默认参数；profiles 选择产品/版本配置，不匹配材料或文档模板名称。产品、单位与写入细节见 device-automation 的 SAM 参考文档。',
      ),
  })
  .strict();

export type SamFileInput = z.infer<typeof samFileInput>;
export const samWrites = new Set<SamFileInput['operation']>(['create', 'modify', 'save-as']);
