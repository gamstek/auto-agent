import type { CompletionRequest, ModelAdapter } from '../src/shared/types';

export function completion(
  text: string,
): Awaited<ReturnType<NonNullable<ModelAdapter['complete']>>> {
  return { text, usage: { totalTokens: 1 }, finishReason: 'stop' };
}

export function sourceText(request: CompletionRequest): string {
  return request.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');
}
