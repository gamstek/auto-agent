import type { ModelMessage, ToolSet } from 'ai';
import type { ModelAdapter, ModelTurn, Message } from '../shared/types';
import type { ContextRetention, ToolResult } from '../tool/context';

export interface RunContext {
  sessionId: string;
  runId: string;
  messageId: string;
  signal: AbortSignal;
}
export interface RunLimits {
  maxSteps: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  modelTimeoutMs: number;
  maxToolCalls: number;
}
export interface ModelRequest {
  messages: ModelMessage[];
  tools: ToolSet;
  signal: AbortSignal;
  onText: (text: string) => void;
  onReasoning: (text: string) => void;
}
export interface ModelGateway {
  generate(request: ModelRequest): Promise<ModelTurn>;
  summarize?: ModelAdapter['summarize'];
}
export interface RunTools {
  definitions?(): unknown;
  modelTools(): ToolSet;
  contextTokenEstimate(): number;
  retentionFor(name: string): ContextRetention | undefined;
  execute(name: string, input: unknown): Promise<ToolResult>;
  eventMetadata(name: string, input: unknown): Record<string, unknown>;
}
export interface ToolEvidence {
  toolCallId: string;
  toolName: string;
  status: string;
  effect: string;
  metadata: unknown;
}
export interface RunnerPorts {
  transcript?: {
    modelOutput(context: RunContext, step: number, text: string, reasoning?: string): void;
    toolCall(
      context: RunContext,
      call: import('../shared/types').ToolCall,
      result?: ToolResult,
    ): void;
  };
  trace?: {
    graph(context: RunContext, graph: unknown): void;
    request(context: RunContext, nodeId: string, kind: 'model' | 'summary', request: unknown): void;
    finish(context: RunContext, nodeId: string, status: string): void;
  };
  model: ModelGateway;
  limits: RunLimits;
  tools(context: RunContext): Promise<RunTools>;
  instructions(context: RunContext): Promise<ModelMessage[]>;
  role: string;
  history(
    context: RunContext,
    toolTokens: number,
    onSummary: (details: Record<string, unknown>) => void,
  ): Promise<ModelMessage[]>;
  checkpoint: import('@langchain/langgraph-checkpoint').BaseCheckpointSaver;
  redact(text: string): string;
  secrets(): readonly string[];
  evidence(context: RunContext, evidence: ToolEvidence): void;
  emit(context: RunContext, type: string, properties?: Record<string, unknown>): void;
}
export interface RunOutput {
  text: string;
  reasoning?: string;
}
export interface AgentRepository {
  getSession(id: string): unknown;
  beginTurn(sessionId: string, content: string): string;
  completeRun(runId: string, sessionId: string, messageId: string, output: RunOutput): Message;
  failRun(
    runId: string,
    sessionId: string,
    messageId: string,
    status: 'failed' | 'cancelled' | 'waiting_for_operator',
    content: string,
  ): Message;
}
