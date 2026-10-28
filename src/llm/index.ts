import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText, type ModelMessage } from 'ai';
import { BuiltinToolRegistry } from '../tool';
export { toolSchemas } from '../tool';
import type { Config } from '../config';
import { KNOWLEDGE_PROMPT } from '../wiki/prompt';
import { SESSION_TITLE_PROMPT } from './prompt';
import { AppError, requireTokenUsage, type ModelAdapter, type ModelTurn } from '../shared/types';
const toolRegistry = new BuiltinToolRegistry();
export function modelFailure(error: unknown): AppError {
  const status =
    error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 0;
  if (status === 401 || status === 403)
    return new AppError(
      'model_auth',
      'Cloud model request failed: authentication rejected. Check AUTO_AGENT_API_KEY and provider permissions.',
      502,
    );
  if (status === 404)
    return new AppError(
      'model_endpoint',
      'Cloud model request failed: model or endpoint not found. Check model and baseURL in configuration.',
      502,
    );
  if (status === 400 || status === 422) {
    const detail = error instanceof Error ? error.message : '';
    const schemaRejected =
      /invalid schema|schema.{0,80}(?:function|tool|object)|(?:tool|function).{0,80}schema/i.test(
        detail,
      );
    return new AppError(
      schemaRejected ? 'model_tool_schema' : 'model_request',
      schemaRejected
        ? `Cloud model request failed: provider rejected tool parameter schemas (HTTP ${status}). Check that every function schema has an object root and uses provider-supported JSON Schema.`
        : `Cloud model request failed: provider rejected request parameters (HTTP ${status}). Check model, tool and generation parameter support.`,
      502,
    );
  }
  if (status === 429)
    return new AppError(
      'model_capacity',
      'Cloud model request failed: provider rate limit or quota exceeded. Check your account and retry later.',
      502,
    );
  if (status >= 500)
    return new AppError(
      'model_unavailable',
      'Cloud model request failed: provider unavailable. Retry later.',
      502,
    );
  return new AppError(
    'model_error',
    'Cloud model request failed. Check model/baseURL, network connectivity, and AUTO_AGENT_API_KEY.',
    502,
  );
}
export class CloudModel implements ModelAdapter {
  constructor(private config: Config) {}
  private provider() {
    return createOpenAICompatible({
      name: 'openai-compatible',
      apiKey: this.config.apiKey,
      baseURL: this.config.baseURL,
      includeUsage: true,
    });
  }
  async generateKnowledge(source: string, signal: AbortSignal): Promise<string> {
    if (!this.config.apiKey)
      throw new AppError(
        'model_configuration',
        'AUTO_AGENT_API_KEY is required for knowledge updates',
        503,
      );
    const provider = this.provider();
    try {
      const result = await generateText({
        model: provider.chatModel(this.config.model),
        instructions: KNOWLEDGE_PROMPT,
        messages: [{ role: 'user', content: source }],
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: this.config.maxOutputTokens,
      });
      if (result.finishReason === 'length')
        throw new AppError('wiki_output_limit', 'Knowledge output exceeded the model output limit');
      return result.text;
    } catch (error) {
      if (signal.aborted || error instanceof AppError) throw error;
      throw modelFailure(error);
    }
  }
  async summarize(messages: ModelMessage[], signal: AbortSignal) {
    if (!this.config.apiKey)
      throw new AppError(
        'model_configuration',
        'AUTO_AGENT_API_KEY is required for context compression',
        503,
      );
    const provider = this.provider();
    try {
      const result = await generateText({
        model: provider.chatModel(this.config.model),
        instructions:
          messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n\n') || undefined,
        messages: messages.filter((message) => message.role !== 'system'),
        abortSignal: signal,
        maxRetries: 0,
        maxOutputTokens: this.config.maxOutputTokens,
      });
      if (result.finishReason === 'length')
        throw new AppError(
          'context_summary_limit',
          'Context summary exceeded maxOutputTokens; no partial summary was used. Increase maxOutputTokens or reduce the history.',
        );
      const usage = result.totalUsage;
      return {
        text: result.text,
        usage: {
          totalTokens: requireTokenUsage(usage),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      };
    } catch (error) {
      if (signal.aborted || error instanceof AppError) throw error;
      throw modelFailure(error);
    }
  }
  async generateTitle(messages: ModelMessage[], signal: AbortSignal): Promise<string> {
    if (!this.config.apiKey)
      throw new AppError(
        'model_configuration',
        'AUTO_AGENT_API_KEY is required. Set it and restart the application; check model/baseURL in configuration.',
        503,
      );
    const provider = this.provider();
    const result = await generateText({
      model: provider.chatModel(this.config.model),
      instructions: SESSION_TITLE_PROMPT,
      messages: messages.filter((message) => message.role !== 'system'),
      abortSignal: signal,
      maxRetries: 0,
      maxOutputTokens: Math.min(128, this.config.maxOutputTokens),
    });
    return result.text;
  }
  async generate(
    messages: ModelMessage[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
    onReasoningDelta?: (text: string) => void,
  ): Promise<ModelTurn> {
    if (!this.config.apiKey)
      throw new AppError(
        'model_configuration',
        'AUTO_AGENT_API_KEY is required. Set it and restart the application; check model/baseURL in configuration.',
        503,
      );
    const provider = this.provider();
    const tools = toolRegistry.modelTools();
    const result = streamText({
      model: provider.chatModel(this.config.model),
      instructions:
        messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n\n') || undefined,
      messages: messages.filter((message) => message.role !== 'system'),
      tools,
      onError: () => {},
      abortSignal: signal,
      maxRetries: 0,
      maxOutputTokens: this.config.maxOutputTokens,
    });
    let text = '';
    let reasoning = '';
    for await (const part of result.fullStream) {
      signal.throwIfAborted();
      if (part.type === 'text-delta') {
        text += part.text;
        onDelta(part.text);
      }
      if (part.type === 'reasoning-delta') {
        reasoning += part.text;
        onReasoningDelta?.(part.text);
      }
      if (part.type === 'error') throw modelFailure(part.error);
    }
    const calls = await result.toolCalls;
    const usage = await result.totalUsage;
    return {
      text,
      ...(reasoning ? { reasoning } : {}),
      toolCalls: calls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input })),
      usage: {
        totalTokens: requireTokenUsage(usage),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    };
  }
}
