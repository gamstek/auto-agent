import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText, type ModelMessage, type ToolSet } from 'ai';
import type { Config } from '../config';
import {
  AppError,
  requireTokenUsage,
  type CompletionRequest,
  type ModelAdapter,
  type ModelTurn,
} from '../shared/types';
import { modelErrorDiagnostic, ModelRequestError } from './errors';
export function modelFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const diagnostic = modelErrorDiagnostic(error);
  const classified = classifyModelFailure(error, diagnostic);
  return new ModelRequestError(classified.code, classified.message, diagnostic);
}
function classifyModelFailure(
  error: unknown,
  diagnostic: ReturnType<typeof modelErrorDiagnostic>,
): AppError {
  const status = diagnostic.httpStatus ?? 0;
  if (status === 402)
    return new AppError(
      'model_billing',
      'Cloud model request rejected (HTTP 402): check the provider account balance or billing status for this API key.',
      502,
    );
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
  if (diagnostic.transportCode) {
    const code = diagnostic.transportCode;
    const dns = ['ENOTFOUND', 'EAI_AGAIN'].includes(code);
    const tls = /CERT|TLS|ISSUER|SIGNATURE/.test(code);
    return new AppError(
      dns ? 'model_dns' : tls ? 'model_tls' : 'model_network',
      dns
        ? 'Cloud model hostname resolution failed. Check DNS and proxy settings on the agent host.'
        : tls
          ? 'Cloud model TLS verification failed. Check system time, certificates and proxy configuration.'
          : 'Cloud model connection failed. Check network/proxy connectivity on the agent host.',
      502,
    );
  }
  if (
    diagnostic.errorNames.some((name) =>
      ['AI_JSONParseError', 'AI_TypeValidationError', 'AI_InvalidResponseDataError'].includes(name),
    )
  )
    return new AppError(
      'model_response',
      'Cloud model returned an invalid or unsupported response. Check provider compatibility and the correlated model diagnostic log.',
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
  async complete({ messages, signal, maxOutputTokens }: CompletionRequest) {
    if (!this.config.apiKey)
      throw new AppError(
        'model_configuration',
        'AUTO_AGENT_API_KEY is required for model requests',
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
        maxOutputTokens: Math.min(
          maxOutputTokens ?? this.config.maxOutputTokens,
          this.config.maxOutputTokens,
        ),
      });
      const usage = result.totalUsage;
      return {
        text: result.text,
        finishReason: result.finishReason,
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
  async summarize(messages: ModelMessage[], signal: AbortSignal) {
    const result = await this.complete({ messages, signal });
    if (result.finishReason === 'length')
      throw new AppError(
        'context_summary_limit',
        'Context summary exceeded maxOutputTokens; no partial summary was used. Increase maxOutputTokens or reduce the history.',
      );
    if (result.finishReason !== 'stop')
      throw new AppError(
        'context_summary',
        'Model did not complete the summary; history was retained',
      );
    return { text: result.text, usage: result.usage };
  }
  async generate(
    messages: ModelMessage[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
    onReasoningDelta?: (text: string) => void,
    generationTools?: ToolSet,
  ): Promise<ModelTurn> {
    if (!this.config.apiKey)
      throw new AppError(
        'model_configuration',
        'AUTO_AGENT_API_KEY is required. Set it and restart the application; check model/baseURL in configuration.',
        503,
      );
    try {
      const provider = this.provider();
      const tools = generationTools ?? {};
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
        finishReason: await result.finishReason,
        ...(reasoning ? { reasoning } : {}),
        toolCalls: calls.map((c) => ({ id: c.toolCallId, name: c.toolName, input: c.input })),
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
}
