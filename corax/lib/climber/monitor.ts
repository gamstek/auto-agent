import { z } from 'zod';
import { inputs, type ClimberResult } from '@auto-agent/climber-mcp/contracts';

export const monitorInput = inputs.start_batch
  .extend({
    experimentIds: z.array(z.string().min(1).max(128)).min(1).max(3),
    simulation: z.boolean().optional(),
    intervalSeconds: z.number().int().min(5).max(300).default(60),
    timeoutHours: z.number().positive().max(168).default(72),
  })
  .refine((input) => new Set(input.experimentIds).size === input.experimentIds.length, {
    message: '实验标识不能重复。',
  });

export type MonitorInput = z.infer<typeof monitorInput>;
/** Learned from manufacturer evidence, never supplied as model arguments. */
export type MonitorExpectation = MonitorInput & {
  deviceRunIds?: { experimentId: string; deviceRunId: string | number }[];
};
export type MonitorStatus = 'watching' | 'completed' | 'attention_required' | 'identity_mismatch';

/** Only fresh, explicitly matching manufacturer evidence can finish a monitor. */
export function assessMonitor(input: MonitorExpectation, result: ClimberResult) {
  const task = result.task;
  const identities = task?.experiments?.map((experiment) => experiment.experimentId);
  const simulations = [task?.simulation, result.health?.simulation].filter(
    (value): value is boolean => typeof value === 'boolean',
  );
  let status: MonitorStatus;
  let reason: string;
  if (
    !task ||
    task.batchId !== input.batchId ||
    !identities ||
    identities.length !== input.experimentIds.length ||
    !input.experimentIds.every((id) => identities.includes(id)) ||
    input.deviceRunIds?.some(
      (expected) =>
        task.experiments?.find((experiment) => experiment.experimentId === expected.experimentId)
          ?.deviceRunId !== expected.deviceRunId,
    ) ||
    (simulations.includes(true) && simulations.includes(false)) ||
    (input.simulation !== undefined &&
      (!simulations.length || simulations.some((value) => value !== input.simulation)))
  ) {
    status = 'identity_mismatch';
    reason =
      '当前批次、实验、厂家运行 ID 或模拟标记与跟踪目标不符，或缺少身份；停止跟踪，不推断原批次完成。';
  } else if (task.state === 'COMPLETED') {
    status = 'completed';
    reason = '厂家新鲜状态明确报告同一批次 COMPLETED；不代表结果文件已核验。';
  } else if (
    ['STARTING', 'RUNNING'].includes(task.state) &&
    result.health?.softwareReady !== false &&
    result.health?.deviceConnected !== false
  ) {
    status = 'watching';
    reason = '同一批次仍在启动或运行。';
  } else {
    status = 'attention_required';
    reason = '厂家状态需要核对，停止自动跟踪；保留原始状态，不推断仪器已停止。';
  }
  return { status, reason, task: task ?? null, health: result.health ?? null };
}
