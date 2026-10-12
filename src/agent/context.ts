import type { ModelMessage } from 'ai';
import { AppError } from '../shared/types';
import { contextRetentionFor } from '../tool';

export function estimatedTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3);
}

export function fitModelContext(messages: ModelMessage[], limit: number, toolTokens = 0) {
  const fullSize = estimatedTokens(messages) + toolTokens;
  if (fullSize <= limit) return { messages, estimatedTokens: fullSize, removedMessages: 0 };
  const system = messages.filter((message) => message.role === 'system');
  const blocks: ModelMessage[][] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === 'system') continue;
    const block: ModelMessage[] = [message];
    if (
      message.role === 'assistant' &&
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'tool-call')
    ) {
      while (messages[index + 1]?.role === 'tool') block.push(messages[++index]!);
    } else if (message.role === 'user') {
      const next = messages[index + 1];
      if (
        next?.role === 'assistant' &&
        (typeof next.content === 'string' ||
          !next.content.some((part) => part.type === 'tool-call'))
      )
        block.push(messages[++index]!);
    }
    blocks.push(block);
  }
  const mandatory = new Set<number>([blocks.length - 1]);
  const pinnedResources = new Map<string, number>();
  let latestUser = -1;
  let latestKnowledge = -1;
  for (const [index, block] of blocks.entries()) {
    if (block.some((message) => message.role === 'user')) latestUser = index;
    for (const message of block) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const call of message.content) {
        if (call.type !== 'tool-call') continue;
        const result = block
          .flatMap((entry) => (entry.role === 'tool' ? entry.content : []))
          .find((entry) => entry.type === 'tool-result' && entry.toolCallId === call.toolCallId);
        if (!result || result.type !== 'tool-result') continue;
        const value = result.output.type === 'json' ? result.output.value : undefined;
        if (value && typeof value === 'object' && 'error' in value) continue;
        const input = call.input as Record<string, unknown> | undefined;
        const retention = contextRetentionFor(call.toolName);
        const key = JSON.stringify((retention?.keys ?? []).map((field) => input?.[field]));
        if (retention?.kind === 'skill' && result.output.type === 'text')
          pinnedResources.set(`skill:${key}`, index);
        if (retention?.kind === 'resource') pinnedResources.set(`resource:${key}`, index);
        if (
          retention?.kind === 'evidence' &&
          value &&
          typeof value === 'object' &&
          'results' in value &&
          Array.isArray(value.results) &&
          value.results.length
        )
          latestKnowledge = index;
      }
    }
  }
  if (latestUser >= 0) mandatory.add(latestUser);
  if (latestKnowledge >= 0) mandatory.add(latestKnowledge);
  for (const index of pinnedResources.values()) mandatory.add(index);
  const notice: ModelMessage = {
    role: 'system',
    content:
      'Earlier conversation or tool results were omitted to fit the context budget. Loaded skill instructions, read resources, the current request and recent evidence are retained. Recover missing identifiers or state with read-only tools; do not guess values, claim unobserved outcomes, or replay uncertain mutations.',
  };
  let size = estimatedTokens([...system, notice]) + toolTokens;
  for (const index of mandatory) if (index >= 0) size += estimatedTokens(blocks[index]);
  if (size > limit)
    throw new AppError(
      'context_budget',
      `Essential instructions and current evidence exceed maxContextTokens (${size}/${limit} estimated tokens). Increase maxContextTokens or reduce resource/result size; no model request was made.`,
    );
  const selected = new Set(mandatory);
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (selected.has(index)) continue;
    const cost = estimatedTokens(blocks[index]);
    if (size + cost <= limit) {
      selected.add(index);
      size += cost;
    }
  }
  const retained = blocks.filter((_block, index) => selected.has(index)).flat();
  const fitted = [...system, notice, ...retained];
  return {
    messages: fitted,
    estimatedTokens: estimatedTokens(fitted) + toolTokens,
    removedMessages: messages.length - system.length - retained.length,
  };
}
