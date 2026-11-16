import { expect, test } from 'bun:test';
import type { MessageStreamEvent } from '@coraxjs/core/client';
import { ChatHistoryCache } from '../src/lib/chat-history-cache';
import { CoraxProjection } from '../src/lib/corax-projection';

function history(id: string, text = '问题') {
  const projection = new CoraxProjection(id);
  const events = [
    { type: 'session.started', data: {} },
    { type: 'turn.started', data: { turnId: 'turn-1', sequence: 0 } },
    { type: 'message.received', data: { turnId: 'turn-1', sequence: 0, message: text } },
  ].map((event, index) => ({
    ...event,
    meta: { id: `event-${index}`, at: '2026-11-07T00:00:00.000Z' },
  })) as MessageStreamEvent[];
  projection.reload(events, false);
  return projection;
}

test('inactive LRU entries transfer official projections and retain the latest event prefix', () => {
  const cache = new ChatHistoryCache(2);
  const first = history('one');
  cache.put(first, 'generation');
  cache.put(history('two'), 'generation');
  const selected = cache.take('one')!;
  expect(selected.projection).toBe(first);
  expect(cache.size).toBe(1);
  selected.projection.append(3, [
    {
      type: 'turn.completed',
      data: { turnId: 'turn-1', sequence: 0 },
      meta: { id: 'event-3', at: '2026-11-07T00:00:01.000Z' },
    },
  ]);
  cache.put(selected.projection, selected.generation);
  cache.put(history('three'), 'generation');
  expect(cache.take('two')).toBeUndefined();
  const restored = cache.take('one')!;
  expect(restored.snapshot.revision).toBe(4);
  expect(restored.snapshot.turnActive).toBe(false);
  expect(restored.snapshot.conversation.messages[0]?.parts).toEqual([
    { type: 'text', text: '问题', state: 'done' },
  ]);
});

test('memory budget evicts inactive entries and skips oversized histories without truncating them', () => {
  const sample = new ChatHistoryCache();
  sample.put(history('one'), 'generation');
  const cost = sample.estimatedBytes;
  const cache = new ChatHistoryCache(8, cost + 32);
  cache.put(history('one'), 'generation');
  cache.put(history('two'), 'generation');
  expect(cache.size).toBe(1);
  expect(cache.estimatedBytes).toBeLessThanOrEqual(cache.maxBytes);
  expect(cache.take('one')).toBeUndefined();
  const oversized = history('huge', '内容'.repeat(cost));
  cache.put(oversized, 'generation');
  expect(cache.take('huge')).toBeUndefined();
  expect(oversized.snapshot().revision).toBe(3);
  expect(cache.take('two')).toBeDefined();
  cache.put(history('one'), 'generation');
  cache.clear();
  expect(cache.size).toBe(0);
  expect(cache.estimatedBytes).toBe(0);
  expect(cache.take('one')).toBeUndefined();
});
