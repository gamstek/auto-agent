import { samWrites, samFileInput, type ClimberMcpTool } from '@auto-agent/climber-mcp/contracts';
import {
  always,
  once,
  never,
  type ApprovalContext,
  type ApprovalStatus,
} from '@coraxjs/core/tools/approval';
import type { ApprovalMode, ApprovalSetting } from '@auto-agent/desktop-protocol';
import { getRuntimeConfig, saveRuntimeApprovalMode } from './config';

export class ApprovalConflictError extends Error {}
const key = Symbol.for('auto-agent.global-approval-setting');
const host = globalThis as typeof globalThis & { [key]?: { value: ApprovalSetting } };

const policies = { always: always<unknown>(), once: once<unknown>(), never: never<unknown>() };

// Policy choices only; Corax still owns all approval requests, grants and durable work.
// Persist only the user's selection, not native request decisions or grants.
export function approvalSetting(): ApprovalSetting {
  host[key] ??= { value: { mode: getRuntimeConfig().approvalMode, revision: 0 } };
  return { ...host[key].value };
}

export function setApprovalSetting(mode: ApprovalMode, revision: number): ApprovalSetting {
  const previous = approvalSetting();
  if (previous.revision !== revision)
    throw new ApprovalConflictError('审批策略已经变化，请重新读取后选择。');
  saveRuntimeApprovalMode(mode);
  const next = { mode, revision: revision + 1 };
  host[key]!.value = next;
  return { ...next };
}

export function requestApproval(
  context: ApprovalContext<unknown>,
): ApprovalStatus | Promise<ApprovalStatus> {
  let mode: ApprovalMode = 'always';
  try {
    mode = approvalSetting().mode;
  } catch {
    /* Unreadable configuration requires native approval. */
  }
  return policies[mode](context);
}

/** Request-time policy only. Corax owns request IDs, decisions and execution. */
export function climberApproval(
  tool: ClimberMcpTool,
  input: unknown,
  context: ApprovalContext,
): ApprovalStatus | Promise<ApprovalStatus> {
  if (tool === 'get_health' || tool === 'get_status') return 'not-applicable';
  if (tool !== 'sam_file') return requestApproval(context);
  const parsed = samFileInput.safeParse(input);
  return parsed.success && !samWrites.has(parsed.data.operation)
    ? 'not-applicable'
    : requestApproval(context);
}
