import { z } from 'zod';
import { AppError, errorText, type ScriptResult } from '../../shared/types';
import { defineTool, UncertainToolError } from '../context';

export const executeScriptTool = defineTool({
  description:
    'Execute a documented script from a skill loaded in this generation. Supply its scripts/ relative path and an argument array. Scripts run with host permissions and may have side effects. Inspect execution status and the skill-defined output; process success is not physical completion. A JSON error code OUTCOME_UNKNOWN is audited as unknown and stops dependent tools. Failed/uncertain writes are not automatically retried.',
  effects: ['process'],
  requiresLoadedSkill: true,
  inputSchema: z.object({
    skill: z.string().min(1),
    path: z.string().min(1),
    args: z.array(z.string().max(4096)).max(64).default([]),
  }),
  outputSchema: z.object({
    status: z.enum(['completed', 'failed', 'cancelled', 'timeout', 'output_limit', 'unknown']),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().nullable(),
  }),
  async execute(input, { skills, executor, audit, run }) {
    const entry = await skills.resolveScript(input.skill, input.path);
    const signature = JSON.stringify([input.skill, entry.path, input.args]);
    if (run.failedScripts.has(signature)) {
      throw new AppError(
        'replay_blocked',
        'A failed script cannot be automatically retried in this generation',
      );
    }
    const executionId = audit.beginExecution(run.id, input.skill, entry.path);
    const record = (result: ScriptResult) => {
      try {
        audit.finishExecution(executionId, result);
      } catch {
        run.failedScripts.add(signature);
        throw new UncertainToolError(
          'Script outcome could not be recorded; manual reconciliation required',
        );
      }
    };
    let result: ScriptResult;
    try {
      result = await executor.execute(input, run.signal);
    } catch (error) {
      run.failedScripts.add(signature);
      const uncertain = !(error instanceof AppError);
      record({ status: uncertain ? 'unknown' : 'failed', exitCode: null, stdout: '', stderr: '' });
      if (uncertain) throw new UncertainToolError(errorText(error));
      throw error;
    }
    // A confirmed process exit does not resolve an external write. Portable
    // scripts report this explicitly through the single-JSON error contract.
    if (result.status === 'completed' || result.status === 'failed') {
      try {
        const output: unknown = JSON.parse(result.stdout);
        if (
          output &&
          typeof output === 'object' &&
          'error' in output &&
          output.error &&
          typeof output.error === 'object' &&
          'code' in output.error &&
          output.error.code === 'OUTCOME_UNKNOWN'
        )
          result = { ...result, status: 'unknown' };
      } catch {
        // Other script output formats retain their executor outcome.
      }
    }
    record(result);
    if (result.status !== 'completed') run.failedScripts.add(signature);
    if (result.status === 'unknown') {
      throw new UncertainToolError('Script outcome is uncertain; manual reconciliation required');
    }
    return { output: result, status: result.status };
  },
});
