import { expect, test } from 'bun:test';
import type { MessageStreamEvent } from '@coraxjs/core/client';
import { CoraxProjection } from '../src/lib/corax-projection';

function history(turns = 200) {
  const events: { type: string; data: unknown }[] = [{ type: 'session.started', data: {} }];
  for (let sequence = 0; sequence < turns; sequence++) {
    const turnId = `turn-${sequence}`;
    events.push({ type: 'turn.started', data: { turnId, sequence } });
    if (sequence === 0)
      events.push({
        type: 'task.started',
        data: { turnId, taskId: 'background', callId: 'call', kind: 'tool', name: 'fixture' },
      });
    events.push(
      { type: 'message.received', data: { turnId, sequence, message: `问题 ${sequence}` } },
      {
        type: 'message.completed',
        data: { turnId, sequence, stepIndex: 0, message: `回答 ${sequence}`, finishReason: 'stop' },
      },
      { type: 'turn.completed', data: { turnId, sequence } },
    );
  }
  return events.map((event, index) => ({
    ...event,
    meta: { id: `event-${index}`, at: '2026-11-11T00:00:00Z' },
  })) as MessageStreamEvent[];
}

test('cooperative history catch-up preserves the full official projection and earlier background work', async () => {
  const events = history();
  const expected = new CoraxProjection('fixture');
  expected.reload(events, false);
  const actual = new CoraxProjection('fixture');
  let yielded = 0;
  expect(
    await actual.catchUp(
      0,
      events,
      false,
      () => true,
      async () => {
        yielded++;
      },
    ),
  ).toBe(true);
  expect(yielded).toBeGreaterThan(0);
  expect(actual.snapshot()).toEqual(expected.snapshot());
  expect(actual.snapshot().conversation.messages).toHaveLength(400);
  expect(actual.snapshot().busy).toBe(true);
  expect(actual.snapshot().turnActive).toBe(false);
});

test('changing the selected view stops catch-up at a valid ordered prefix instead of completing a stale view', async () => {
  const events = history();
  const actual = new CoraxProjection('fixture');
  let current = true;
  expect(
    await actual.catchUp(
      0,
      events,
      false,
      () => current,
      async () => {
        current = false;
      },
    ),
  ).toBe(false);
  expect(actual.nextIndex).toBeGreaterThan(0);
  expect(actual.nextIndex).toBeLessThan(events.length);
  const expected = new CoraxProjection('fixture');
  expected.reload(events.slice(0, actual.nextIndex), false);
  expect(actual.snapshot()).toEqual(expected.snapshot());
});

test('a live contiguous suffix can overtake catch-up without duplicating messages or restoring old admission', async () => {
  const events = history();
  const actual = new CoraxProjection('fixture');
  let appended = false;
  const settled = {
    type: 'task.settled',
    data: {
      turnId: 'turn-0',
      taskId: 'background',
      callId: 'call',
      status: 'completed',
      output: null,
    },
    meta: { id: 'settled', at: '2026-11-11T00:00:01Z' },
  } as MessageStreamEvent;
  expect(
    await actual.catchUp(
      0,
      events,
      true,
      () => true,
      async () => {
        if (appended) return;
        appended = true;
        actual.append(actual.nextIndex, [...events.slice(actual.nextIndex), settled]);
      },
    ),
  ).toBe(true);
  expect(appended).toBe(true);
  expect(actual.nextIndex).toBe(events.length + 1);
  expect(actual.snapshot().conversation.messages).toHaveLength(400);
  expect(actual.snapshot().busy).toBe(false);
});
