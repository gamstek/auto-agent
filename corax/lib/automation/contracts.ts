import { z } from 'zod';

const identifier = z.string().trim().min(1).max(128);
const experimentId = z.uuid();
const ids = <T extends z.ZodType<string>>(id: T) =>
  z
    .array(id)
    .min(1)
    .max(100)
    .refine((items) => new Set(items).size === items.length, '编号不可重复');

export const templateQuery = z.object({ templateIds: ids(identifier).optional() }).strict();
export const experimentQuery = z.object({ experimentIds: ids(experimentId) }).strict();
const combination = z
  .object({ templateId: identifier, versionId: identifier, tubeCode: identifier })
  .strict();
export const createBatchInput = z
  .object({
    items: z
      .array(combination)
      .min(1)
      .max(100)
      .refine(
        (items) => new Set(items.map(({ tubeCode }) => tubeCode)).size === items.length,
        '同批样品管码不可重复',
      ),
  })
  .strict();

const batch = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item) });
const status = z.enum(['pending', 'running', 'completed', 'failed']);
const itemError = z.object({
  experimentId,
  status: z.literal('error'),
  code: identifier,
  message: z.string().max(2000),
});
const timestamp = z.iso.datetime({ offset: true }).nullable();

export const templatesResponse = batch(
  z.object({
    templateId: identifier,
    versionId: identifier,
    name: z.string().min(1).max(512),
    description: z.string().max(4000).optional(),
  }),
);
export const creationResponse = batch(
  z.discriminatedUnion('status', [
    z.object({ experimentId, status: z.literal('accepted'), tubeCode: identifier }),
    itemError,
  ]),
);
export const progressResponse = batch(
  z.discriminatedUnion('status', [
    z.object({
      experimentId,
      status,
      message: z.string().max(2000).optional(),
      steps: z.array(
        z.object({
          stage: identifier,
          status,
          startedAt: timestamp,
          finishedAt: timestamp,
          message: z.string().max(2000).optional(),
        }),
      ),
    }),
    itemError,
  ]),
);
export const resultsResponse = batch(
  z.discriminatedUnion('status', [
    z.object({
      experimentId,
      status: z.literal('ready'),
      metrics: z.array(
        z.object({ name: identifier, value: z.number(), unit: z.string().max(128) }),
      ),
      isotherms: z.array(
        z.object({
          branch: identifier,
          xUnit: identifier,
          yUnit: identifier,
          points: z.array(z.tuple([z.number(), z.number()])),
        }),
      ),
    }),
    z.object({ experimentId, status: z.literal('not_ready') }),
    itemError,
  ]),
);

export const automationTools = {
  automation_list_templates:
    '批量获取自动化仪器的正式可用模板；不指定编号时取全部。按实际返回的 templateId/versionId 选用，不能用 SAM 或历史模板代替。',
  automation_create_experiments:
    '按用户本轮明确的创建要求一次提交整批模板版本和已入库样品管组合。仅选模板不创建。保留逐项实验编号；效果未知时只查原编号，不重发、不改用单仪器启动。',
  automation_get_progress:
    '按一组原实验编号批量查询自动化仪器的实际阶段。可核对创建回执不明的原实验；查不到不能断言不会受理。',
  automation_get_results:
    '按一组原实验编号批量获取自动化仪器的实测指标、单位及等温线。每项独立返回，未就绪不能当成零或失败。',
} as const;

export function automationToolCatalog(enabled: boolean) {
  return enabled
    ? Object.entries(automationTools).map(([name, description]) => ({ name, description }))
    : [];
}
