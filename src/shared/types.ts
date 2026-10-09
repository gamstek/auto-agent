import type { ModelMessage } from 'ai';
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
  toolCalls: ToolCall[];
  totalTokens: number;
}
export interface ModelAdapter {
  generateTitle?(messages: ModelMessage[], signal: AbortSignal): Promise<string>;
  generate(
    messages: ModelMessage[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
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
export function errorText(error: unknown): string {
  return error instanceof AppError ? error.message : 'Internal operation failed';
}
