import { AppError, errorText, type ToolCall } from '../shared/types';
import { UncertainToolError, type ToolResult } from './context';
import { evidenceMetadata } from './evidence';
import type { RunTools, ToolEvidence } from '../agent/contracts';

export class ToolExecutor {
  constructor(
    private tools: RunTools,
    private signal: AbortSignal,
    private redact: (text: string) => string,
    private emit: (type: string, properties: Record<string, unknown>) => void,
    private record: (evidence: ToolEvidence) => void,
    private capture?: (call: ToolCall, result?: ToolResult) => void,
  ) {}
  async execute(call: ToolCall): Promise<ToolResult> {
    const started = Date.now(),
      identity = { name: call.name, toolCallId: call.id };
    const metadata = JSON.parse(
      this.redact(JSON.stringify(this.tools.eventMetadata(call.name, call.input))),
    );
    this.emit('tool.started', { ...metadata, ...identity, status: 'running' });
    this.capture?.(call);
    let result: ToolResult;
    try {
      this.signal.throwIfAborted();
      result = await this.tools.execute(call.name, call.input);
    } catch (error) {
      result =
        error instanceof UncertainToolError && error.toolResult
          ? { ...error.toolResult, effect: 'unknown' }
          : {
              status: this.signal.aborted ? 'cancelled' : 'failed',
              effect: error instanceof UncertainToolError ? 'unknown' : 'none',
              output: {
                error: error instanceof AppError ? error.code : 'tool_error',
                message: errorText(error),
                ...(error instanceof UncertainToolError && error.diagnostic
                  ? { diagnostic: error.diagnostic }
                  : {}),
              },
            };
    }
    const status = result.effect === 'unknown' ? 'unknown' : result.status;
    this.capture?.(call, result);
    try {
      this.record({
        toolCallId: call.id,
        toolName: call.name,
        status,
        effect: result.effect,
        metadata: JSON.parse(this.redact(JSON.stringify(evidenceMetadata(result.output)))),
      });
    } catch (error) {
      if (result.effect === 'unknown')
        throw new UncertainToolError(
          'Unknown tool outcome could not be recorded; manual reconciliation required',
        );
      throw new AppError(
        'tool_evidence_storage',
        'Tool evidence could not be recorded; dependent tools were not executed',
        500,
      );
    }
    this.emit(
      result.status === 'completed' && result.effect !== 'unknown'
        ? 'tool.completed'
        : 'tool.failed',
      {
        ...identity,
        status,
        durationMs: Date.now() - started,
        ...(result.status !== 'completed' || result.effect === 'unknown'
          ? { message: `Tool finished with status: ${status}` }
          : {}),
      },
    );
    return result;
  }
}
