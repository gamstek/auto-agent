import { z } from 'zod';

export const samFileInput = z
  .object({
    operation: z.enum(['profiles', 'inspect', 'compare', 'create', 'modify', 'save-as']),
    input: z
      .record(z.string(), z.unknown())
      .describe(
        '操作参数对象。profiles: {} 或 {product}；inspect: {path,product}；compare: {path,product,requirements,tolerances?}；create: {product,settings,path?,profile?} 或 {path,product,template}；modify: {path,product,expectedSha256,changes?,reportTypes?}；save-as: {path,sourcePath,product,expectedSha256,changes?,reportTypes?}。产品、单位与写入细节见 device-automation 的 SAM 参考文档。',
      ),
  })
  .strict();

export type SamFileInput = z.infer<typeof samFileInput>;
export const samWrites = new Set<SamFileInput['operation']>(['create', 'modify', 'save-as']);
