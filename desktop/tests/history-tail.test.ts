import { expect, test } from 'bun:test';
import type { MessageStreamEvent } from '@coraxjs/core/client';
import { projectHistoryTail } from '../src/lib/history-tail';
import { CoraxProjection } from '../src/lib/corax-projection';

const events = [
  { type: 'session.started', data: {} },
  ...Array.from({ length: 3 }, (_, sequence) => {
    const turnId = `turn-${sequence}`;
    return [
      { type: 'turn.started', data: { turnId, sequence } },
      { type: 'message.received', data: { turnId, sequence, message: `问题 ${sequence}` } },
      {
        type: 'message.completed',
        data: { turnId, sequence, stepIndex: 0, message: `回答 ${sequence}`, finishReason: 'stop' },
      },
      { type: 'turn.completed', data: { turnId, sequence } },
    ];
  }).flat(),
].map((event, index) => ({
  ...event,
  meta: { id: `event-${index}`, at: '2026-11-11T00:00:00Z' },
})) as MessageStreamEvent[];

test('tail preview skips an incomplete first turn and retains native message identities', async () => {
  const canonical = new CoraxProjection('fixture');
  canonical.reload(events, false);
  const preview = await projectHistoryTail('fixture', events.slice(3));
  expect(preview!.snapshot.conversation.messages.map((message) => message.id)).toEqual(
    canonical
      .snapshot()
      .conversation.messages.slice(2)
      .map((message) => message.id),
  );
  expect(preview!.snapshot.conversation.messages).toHaveLength(4);
});

test('stream fragments need a real boundary, but an actual completed reply can be shown without inventing a turn', async () => {
  expect(
    await projectHistoryTail(
      'fixture',
      events.filter((event) => event.type === 'turn.completed'),
    ),
  ).toBeNull();
  const preview = await projectHistoryTail('fixture', events.slice(-3));
  expect(preview!.kind).toBe('reply');
  expect(preview!.snapshot.conversation.messages).toHaveLength(1);
  const canonical = new CoraxProjection('fixture');
  canonical.reload(events, false);
  expect(preview!.snapshot.conversation.messages[0]!.id).toBe(
    canonical.snapshot().conversation.messages.at(-1)!.id,
  );
  expect(Object.keys(preview!.snapshot.conversation.turns)).toHaveLength(0);
  expect(await projectHistoryTail('fixture', events, () => false)).toBeNull();
});

test('out-of-window late turn events cannot create phantom preview messages', async () => {
  const late = {
    type: 'message.completed',
    data: {
      turnId: 'turn-0',
      sequence: 0,
      stepIndex: 0,
      message: 'old late reply',
      finishReason: 'stop',
    },
    meta: { id: 'late-event', at: '2026-11-11T00:00:01Z' },
  } as MessageStreamEvent;
  const preview = await projectHistoryTail('fixture', [...events.slice(-4), late]);
  expect(preview!.snapshot.conversation.messages).toHaveLength(2);
  expect(JSON.stringify(preview)).not.toContain('old late reply');
});

test('a clear boundary prevents previewing an earlier completed reply or turn', async () => {
  const clear = {
    type: 'context.cleared',
    data: {},
    meta: { id: 'clear', at: '2026-11-11T00:00:01Z' },
  } as MessageStreamEvent;
  expect(await projectHistoryTail('fixture', [...events, clear])).toBeNull();
  expect(await projectHistoryTail('fixture', [...events.slice(-3), clear])).toBeNull();
  const preview = await projectHistoryTail('fixture', [...events, clear, ...events.slice(-4)]);
  expect(preview!.snapshot.conversation.messages).toHaveLength(2);
});

test('a bounded preview retains complete tool declarations, outputs and official call state within its turn', async () => {
  const coordinates = { turnId: 'turn-2', sequence: 2, stepIndex: 0 };
  const middle = [
    {
      type: 'actions.requested',
      data: {
        ...coordinates,
        actions: [
          {
            kind: 'tool-call',
            callId: 'call',
            toolName: 'fixture',
            input: { path: 'source-evidence.md' },
          },
        ],
      },
    },
    {
      type: 'task.started',
      data: { turnId: 'turn-2', taskId: 'task', callId: 'call', name: 'fixture', kind: 'tool' },
    },
    {
      type: 'action.result',
      data: {
        ...coordinates,
        status: 'completed',
        result: {
          kind: 'tool-result',
          callId: 'call',
          toolName: 'fixture',
          output: { text: 'source-evidence-output' },
        },
      },
    },
    {
      type: 'task.settled',
      data: {
        turnId: 'turn-2',
        taskId: 'task',
        callId: 'call',
        status: 'completed',
        output: { text: 'source-evidence-output' },
      },
    },
  ].map((event, index) => ({
    ...event,
    meta: { id: `tool-event-${index}`, at: '2026-11-11T00:00:00Z' },
  })) as MessageStreamEvent[];
  const preview = await projectHistoryTail('fixture', [
    ...events.slice(-4, -2),
    ...middle,
    ...events.slice(-2),
  ]);
  expect(preview!.snapshot.calls.call!.status).toBe('completed');
  expect(JSON.stringify(preview!.snapshot.conversation.messages)).toContain(
    'source-evidence-output',
  );
});
