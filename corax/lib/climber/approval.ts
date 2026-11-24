import { samWrites, samFileInput, type ClimberMcpTool } from '@auto-agent/climber-mcp/contracts';
import type { ApprovalContext, ApprovalStatus } from '@coraxjs/core/tools/approval';
import { requestApproval } from '../approval/policy';

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
