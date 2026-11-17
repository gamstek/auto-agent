/// <reference types="@coraxjs/core/workflow-modules" />
import { sleep } from 'workflow';
import type { WorkflowToolContext, WorkflowStepToolContext } from '@coraxjs/core/tools';
import type { MonitorInput, MonitorExpectation } from './monitor';

async function observe(
  input: MonitorExpectation,
  target: string | null,
  ctx: WorkflowStepToolContext,
) {
  'use step';

  const { createHash } = await import('node:crypto');
  const { resultSchema } = await import('@auto-agent/climber-mcp/contracts');
  const { callClimber } = await import('./index');
  const { assessMonitor } = await import('./monitor');
  const { getRuntimeConfig } = await import('../config');
  const config = getRuntimeConfig();
  const identity = createHash('sha256')
    .update(JSON.stringify([config.dataDir, config.climber.serviceURL]))
    .digest('hex');
  const observedAt = Date.now();
  if (!config.climber.enabled || (target !== null && identity !== target))
    return {
      target: identity,
      observedAt,
      status: 'configuration_changed' as const,
      reason: 'Climber 配置已禁用或目标已改变，停止跟踪，不查询新地址。',
    };
  const reply = await callClimber(
    config,
    'get_status',
    {},
    {
      sessionId: ctx.session.id,
      callId: ctx.callId,
      signal: ctx.abortSignal,
    },
  );
  if (reply.error)
    return {
      target: identity,
      observedAt: Date.now(),
      status: 'unavailable' as const,
      reason: '状态查询失败，停止跟踪；设备执行状态未知，不自动重启跟踪或重试写入。',
      error: reply.error,
    };
  return {
    target: identity,
    observedAt: Date.now(),
    ...assessMonitor(input, resultSchema.parse(reply)),
  };
}

export async function monitor(input: MonitorInput, ctx: WorkflowToolContext) {
  'use workflow';

  let observation = await observe(input, null, ctx);
  const expected: MonitorExpectation = { ...input, deviceRunIds: [] };
  const deadline = observation.observedAt + input.timeoutHours * 3_600_000;
  let checks = 1;
  let lastKnown = observation.status === 'watching' ? observation : null;
  while (observation.status === 'watching') {
    // Pin each identity as soon as the manufacturer first supplies it. An
    // initially absent simulation/run ID must not permit a later replacement.
    expected.simulation ??= observation.task?.simulation ?? observation.health?.simulation;
    for (const experiment of observation.task?.experiments ?? []) {
      const id = experiment.deviceRunId;
      if (
        id !== undefined &&
        id !== null &&
        id !== '' &&
        !expected.deviceRunIds!.some((known) => known.experimentId === experiment.experimentId)
      )
        expected.deviceRunIds!.push({ experimentId: experiment.experimentId, deviceRunId: id });
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      return {
        ...observation,
        status: 'timeout',
        reason: '跟踪达到时限；最后一次状态不是完成证据，仪器可能仍在运行。',
        batchId: input.batchId,
        experimentIds: input.experimentIds,
        checks,
      };
    await sleep(Math.min(input.intervalSeconds * 1000, remaining));
    lastKnown = observation;
    observation = await observe(expected, observation.target, ctx);
    checks++;
  }
  return {
    ...observation,
    batchId: input.batchId,
    experimentIds: input.experimentIds,
    checks,
    ...(observation.status === 'completed' ? {} : { lastKnown }),
  };
}
