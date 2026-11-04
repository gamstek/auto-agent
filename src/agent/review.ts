import type { Store } from '../storage';
import type { Diagnostics } from '../shared/diagnostics';

export function reviewReport(
  store: Store,
  diagnostics: Diagnostics,
  sessionId: string,
  redact: (text: string) => string,
) {
  const pending = store.pendingReview(sessionId);
  return {
    pending: JSON.parse(redact(JSON.stringify(pending))) as typeof pending,
    logs: diagnostics.paths(),
  };
}

export function reviewText(
  store: Store,
  diagnostics: Diagnostics,
  sessionId: string,
  redact: (text: string) => string,
): string {
  const { pending, logs } = reviewReport(store, diagnostics, sessionId, redact);
  if (!pending)
    return redact(
      `No operator review is pending for this session.\nAgent log: ${logs.agent}\nSkill log: ${logs.skills}`,
    );
  const lines = ['等待对账 / Operator review required', `Run: ${pending.id}`];
  const entries = [
    ...pending.executions.map((entry) => ({ ...entry, label: `${entry.skill} / ${entry.path}` })),
    ...pending.operations.map((entry) => ({
      ...entry,
      label: `${entry.serverId} / ${entry.toolName}`,
    })),
  ];
  for (const entry of entries.filter((item) => item.status === 'unknown')) {
    lines.push(`Execution: ${entry.id}`, `Operation: ${entry.label}`);
    if (entry.diagnostic) {
      for (const [key, value] of Object.entries(entry.diagnostic).slice(0, 16))
        if (value !== undefined && value !== null)
          lines.push(
            `${key.charAt(0).toUpperCase() + key.slice(1)}: ${String(typeof value === 'object' ? JSON.stringify(value) : value).slice(0, 2000)}`,
          );
    } else
      lines.push(
        '该执行未记录结构化错误；请查看操作日志，不能据此推断外部效果。',
      );
  }
  lines.push(
    `Agent log: ${logs.agent}`,
    `Skill log: ${logs.skills}`,
    '仅显示诊断，不会重放操作或解除待对账状态。核对外部操作结果后，可由操作者使用 /resolve <runId> <核对说明> 记录处理结果。',
  );
  return redact(lines.join('\n'));
}
