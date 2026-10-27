import type { LanguageModelUsage, ModelMessage } from 'ai';

export type ModelTokenUsage = Partial<
  Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>
>;
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}
export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}
export interface AgentEvent {
  type: string;
  sessionId: string;
  messageId: string;
  properties: Record<string, unknown>;
}
export interface SkillInfo {
  name: string;
  description: string;
  directory: string;
  metadata: Record<string, unknown>;
}
export interface ScriptRequest {
  skill: string;
  path: string;
  args?: string[];
}
export interface ScriptResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'output_limit' | 'unknown';
  stdout: string;
  stderr: string;
  exitCode: number | null;
}
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface ModelTurn {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage: ModelTokenUsage;
}
export interface ModelAdapter {
  summarize?(
    messages: ModelMessage[],
    signal: AbortSignal,
  ): Promise<{ text: string; usage: ModelTokenUsage }>;
  generateKnowledge?(source: string, signal: AbortSignal): Promise<string>;
  generateTitle?(messages: ModelMessage[], signal: AbortSignal): Promise<string>;
  generate(
    messages: ModelMessage[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
    onReasoningDelta?: (text: string) => void,
  ): Promise<ModelTurn>;
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function requireTokenUsage(usage: ModelTokenUsage): number {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (
    !usage ||
    typeof usage !== 'object' ||
    !valid(usage.totalTokens) ||
    (usage.inputTokens !== undefined && !valid(usage.inputTokens)) ||
    (usage.outputTokens !== undefined && !valid(usage.outputTokens)) ||
    (usage.inputTokens !== undefined &&
      usage.outputTokens !== undefined &&
      usage.totalTokens !== usage.inputTokens + usage.outputTokens)
  ) {
    throw new AppError(
      'model_usage',
      'Model did not return valid token usage. Check that the provider reports usage for streamed requests; this generation stopped and pending tools were not executed.',
      502,
    );
  }
  return usage.totalTokens;
}

export function errorText(error: unknown): string {
  return error instanceof AppError ? error.message : 'Internal operation failed';
}
