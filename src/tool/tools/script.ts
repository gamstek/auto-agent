import { z } from 'zod';
import { AppError, errorText, type ScriptResult } from '../../shared/types';
import { defineTool, UncertainToolError } from '../context';

export const executeScriptTool = defineTool({
  description:
    'Execute a script in a loaded trusted skill. Scripts have host permissions and may cause side effects. Never retry uncertain side effects.',
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
    record(result);
    if (result.status !== 'completed') run.failedScripts.add(signature);
    if (result.status === 'unknown') {
      throw new UncertainToolError(
        'Script termination is unconfirmed; manual reconciliation required',
      );
    }
    return { output: result, status: result.status };
  },
});
