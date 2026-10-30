import { z } from 'zod';
import { AppError, errorText, type ScriptResult } from '../../shared/types';
import { defineTool, UncertainToolError } from '../context';
import { sanitizeDiagnostic } from '../../shared/diagnostics';

export const executeScriptTool = defineTool({
  description:
    'Execute a documented script from a skill loaded in this generation. Supply its scripts/ relative path and an argument array. Scripts run with host permissions and may have side effects. Inspect execution status and the skill-defined output; process success is not physical completion. A JSON error code OUTCOME_UNKNOWN is audited as unknown and stops dependent tools. Failed/uncertain writes are not automatically retried.',
  effects: ['process'],
  requiresLoadedSkill: true,
  inputSchema: z.object({
    skill: z.string().min(1),
    path: z.string().min(1),
    args: z
      .array(z.string().max(4096))
      .max(64)
      .default([])
      .describe(
        'Individual argv strings in the script-defined order. For command-based scripts, put the documented command first; a JSON payload is one serialized string after it, never the command name. Do not invent commands.',
      ),
  }),
  outputSchema: z.object({
    status: z.enum(['completed', 'failed', 'cancelled', 'timeout', 'output_limit', 'unknown']),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().nullable(),
  }),
  async execute(input, { skills, executor, audit, run, diagnostics }) {
    const entry = await skills.resolveScript(input.skill, input.path);
    const signature = JSON.stringify([input.skill, entry.path, input.args]);
    if (run.failedScripts.has(signature)) {
      throw new AppError(
        'replay_blocked',
        'A failed script cannot be automatically retried in this generation',
      );
    }
    const executionId = audit.beginExecution(run.id, input.skill, entry.path);
    let diagnostic: Record<string, unknown> | undefined;
    let observed: Record<string, unknown> | undefined;
    const record = (result: ScriptResult) => {
      try {
        audit.finishExecution(executionId, result, diagnostic);
      } catch {
        run.failedScripts.add(signature);
        throw new UncertainToolError(
          'Script outcome could not be recorded; manual reconciliation required',
        );
      }
    };
    let result: ScriptResult;
    try {
      result = await executor.execute(input, run.signal, { runId: run.id, executionId });
    } catch (error) {
      run.failedScripts.add(signature);
      const uncertain = !(error instanceof AppError);
      diagnostic = (diagnostics?.sanitize({
        code: error instanceof AppError ? error.code : 'script_error',
        message: errorText(error),
      }) ??
        sanitizeDiagnostic({
          code: error instanceof AppError ? error.code : 'script_error',
          message: errorText(error),
        })) as Record<string, unknown>;
      record({ status: uncertain ? 'unknown' : 'failed', exitCode: null, stdout: '', stderr: '' });
      if (uncertain) throw new UncertainToolError(errorText(error));
      throw error;
    }
    // A confirmed process exit does not resolve an external write. Portable
    // scripts report this explicitly through the single-JSON error contract.
    {
      try {
        const output: unknown = JSON.parse(result.stdout);
        if (
          output &&
          typeof output === 'object' &&
          'error' in output &&
          output.error &&
          typeof output.error === 'object' &&
          'code' in output.error
        ) {
          const raw = output.error as Record<string, unknown>;
          const selected = Object.fromEntries(
            ['code', 'message', 'batchId', 'stage', 'status', 'diagnostic', 'cause']
              .filter((key) => Object.hasOwn(raw, key))
              .map((key) => [key, raw[key]]),
          );
          diagnostic = (diagnostics?.sanitize(selected) ?? sanitizeDiagnostic(selected)) as Record<
            string,
            unknown
          >;
          diagnostics?.write('skills', 'script.diagnostic', {
            runId: run.id,
            executionId,
            ...diagnostic,
          });
          if (raw.code === 'OUTCOME_UNKNOWN') result = { ...result, status: 'unknown' };
        } else if (output && typeof output === 'object') {
          const selected = Object.fromEntries(
            [
              'backend',
              'operation',
              'batchId',
              'stage',
              'file',
              'pendingInputs',
              'sampleInputsComplete',
            ]
              .filter((key) => Object.hasOwn(output, key))
              .map((key) => [key, (output as Record<string, unknown>)[key]]),
          );
          observed = (diagnostics?.sanitize(selected) ?? sanitizeDiagnostic(selected)) as Record<
            string,
            unknown
          >;
          diagnostics?.write('skills', 'script.result', {
            runId: run.id,
            executionId,
            ...selected,
          });
        }
      } catch {
        // Other script output formats retain their executor outcome.
      }
    }
    if (!diagnostic && result.status !== 'completed')
      diagnostic = {
        code: `SCRIPT_${result.status.toUpperCase()}`,
        message: `Script finished with status ${result.status}; inspect the correlated skills log for process/stream details.`,
        exitCode: result.exitCode,
        ...(observed ? { observed } : {}),
      };
    record(result);
    diagnostics?.write('skills', 'execution.outcome', {
      runId: run.id,
      executionId,
      status: result.status,
      exitCode: result.exitCode,
      diagnosticCode: diagnostic?.code,
    });
    if (result.status !== 'completed') run.failedScripts.add(signature);
    if (result.status === 'unknown') {
      throw new UncertainToolError(
        diagnostic && typeof diagnostic.message === 'string'
          ? `${String(diagnostic.code)}: ${diagnostic.message}`
          : 'Script outcome is uncertain; manual reconciliation required',
        diagnostic,
      );
    }
    return { output: result, status: result.status };
  },
});
