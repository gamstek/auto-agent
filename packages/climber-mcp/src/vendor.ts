import { z } from 'zod';

const text = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .refine((s) => s.trim().length > 0);
const batch = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/)
  .refine((s) => !['.', '..'].includes(s));
const experiment = z
  .object({
    experimentId: text,
    analysisPort: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    tubeNo: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    samPath: z
      .string()
      .max(4096)
      .regex(/^[A-Za-z]:[\\/].+\.[sS][aA][mM]$/)
      .regex(/^[^\x00-\x1f\x7f]+$/),
    sampleName: text.refine((s) => !/[<>:"/\\|?*]/.test(s)),
    emptyTubeMassG: z.number().positive(),
    sampleMassG: z.number().positive(),
  })
  .strict();
export const inputs = {
  get_health: z.object({}).strict(),
  get_status: z.object({}).strict(),
  register_batch: z
    .object({ batchId: batch, experiments: z.array(experiment).min(1).max(3) })
    .strict()
    .superRefine((v, context) => {
      for (const values of [
        v.experiments.map((e) => e.experimentId),
        v.experiments.map((e) => e.analysisPort),
        v.experiments.map((e) => e.tubeNo % 72 || 72),
      ]) {
        if (new Set<string | number>(values).size !== values.length)
          context.addIssue({ code: 'custom', message: '实验ID、分析口和映射后的管号必须唯一' });
      }
    }),
  start_batch: z.object({ batchId: batch }).strict(),
};
export type ClimberTool = keyof typeof inputs;
export class VendorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: 'rejected' | 'unknown' | 'unavailable',
    readonly vendorCode?: string,
  ) {
    super(message);
  }
}
const taskSchema = z
  .object({
    batchId: text.max(64),
    state: text,
    analysisStarted: z.boolean().optional(),
    simulation: z.boolean().optional(),
    experiments: z
      .array(
        z
          .object({
            experimentId: text,
            analysisPort: z.number().int().optional(),
            state: text.optional(),
            deviceRunId: z.union([text, z.number()]).nullable().optional(),
          })
          .strip(),
      )
      .max(72)
      .optional(),
  })
  .strip()
  .refine(
    (task) =>
      !task.experiments ||
      new Set(task.experiments.map((e) => e.experimentId)).size === task.experiments.length,
    'Conflicting experiment identities',
  );
export const healthSchema = z
  .object({
    softwareReady: z.boolean().nullable().optional(),
    deviceConnected: z.boolean().nullable().optional(),
    deviceBusy: z.boolean().nullable().optional(),
    version: z.string().max(128).optional(),
    softwareVersion: z.string().max(128).optional(),
    clientVersion: z.string().max(128).optional(),
    apiVersion: z.string().max(128).optional(),
    simulation: z.boolean().optional(),
  })
  .strip();
export const resultSchema = z
  .object({
    source: z.literal('climber-vendor'),
    operation: z.enum(['get_health', 'get_status', 'register_batch', 'start_batch']),
    health: healthSchema.optional(),
    task: taskSchema.nullable().optional(),
    tubeMapping: z
      .array(z.object({ experimentId: text, tubeNo: z.number(), vendorTubeNo: z.number() }))
      .optional(),
  })
  .strict();
export type ClimberResult = z.infer<typeof resultSchema>;

export async function callVendor(
  name: ClimberTool,
  raw: unknown,
  baseURL: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ClimberResult> {
  const input = inputs[name].parse(raw);
  const write = name === 'register_batch' || name === 'start_batch';
  const invalid = () =>
    new VendorError(
      write ? 'OUTCOME_UNKNOWN' : 'INVALID_RESPONSE',
      '厂家响应无效或任务身份不匹配',
      write ? 'unknown' : 'unavailable',
    );
  const registration = name === 'register_batch' ? inputs.register_batch.parse(input) : null;
  const batchId = 'batchId' in input ? input.batchId : undefined;
  const tubeMapping = registration?.experiments.map((e) => ({
    experimentId: e.experimentId,
    tubeNo: e.tubeNo,
    vendorTubeNo: e.tubeNo % 72 || 72,
  }));
  const route = registration
    ? 'tasks'
    : name === 'start_batch'
      ? `tasks/${encodeURIComponent(batchId!)}/start`
      : name === 'get_health'
        ? 'health'
        : 'status';
  let response: Response, body: any;
  try {
    response = await fetch(`${baseURL.replace(/\/$/, '')}/${route}`, {
      method: write ? 'POST' : 'GET',
      redirect: 'error',
      headers: write ? { 'Content-Type': 'application/json' } : {},
      ...(write
        ? {
            body: JSON.stringify(
              registration
                ? {
                    batchId,
                    experiments: registration.experiments.map((e, i) => ({
                      ...e,
                      tubeNo: tubeMapping![i].vendorTubeNo,
                    })),
                  }
                : {},
            ),
          }
        : {}),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
    if (!response.body) throw invalid();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 65536) {
          await reader.cancel();
          throw invalid();
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new VendorError(
      write ? 'OUTCOME_UNKNOWN' : 'SERVICE_UNAVAILABLE',
      '无法确认厂家请求结果，请保留批次与阶段核对',
      write ? 'unknown' : 'unavailable',
    );
  }
  if (
    body?.ok === false &&
    typeof body.error?.code === 'string' &&
    typeof body.error?.message === 'string'
  )
    throw new VendorError(
      'COMMAND_REJECTED',
      '厂家明确拒绝本次请求',
      write ? 'rejected' : 'unavailable',
      /^[A-Z0-9_]{1,128}$/.test(body.error.code) ? body.error.code : undefined,
    );
  if (!response.ok || body?.ok !== true || !body.data || typeof body.data !== 'object')
    throw invalid();
  try {
    if (name === 'get_health')
      return { source: 'climber-vendor', operation: name, health: healthSchema.parse(body.data) };
    if (name === 'get_status')
      return {
        source: 'climber-vendor',
        operation: name,
        health: healthSchema.parse(body.data.health),
        task: taskSchema.nullable().parse(body.data.task),
      };
    const nested = body.data.task;
    if (
      name === 'start_batch' &&
      nested &&
      (('batchId' in body.data && body.data.batchId !== nested.batchId) ||
        ('state' in body.data && body.data.state !== nested.state))
    )
      throw invalid();
    const task = taskSchema.parse(registration ? nested : (nested ?? body.data));
    if (task.batchId !== batchId) throw invalid();
    if (
      registration &&
      task.experiments &&
      (task.experiments.length !== registration.experiments.length ||
        task.experiments.some((actual) => {
          const expected = registration.experiments.find(
            (e) => e.experimentId === actual.experimentId,
          );
          return (
            !expected ||
            (actual.analysisPort !== undefined && actual.analysisPort !== expected.analysisPort)
          );
        }))
    )
      throw invalid();
    return {
      source: 'climber-vendor',
      operation: name,
      task,
      ...(tubeMapping ? { tubeMapping } : {}),
    };
  } catch {
    throw invalid();
  }
}
