import { expect, test } from 'bun:test';
import type { MessageStreamEvent } from '@coraxjs/core/client';
import { chatPresentation } from '../src/lib/chat-presentation';
import { CoraxProjection } from '../src/lib/corax-projection';

function projection(events: { type: string; data: unknown }[] = []) {
  const value = new CoraxProjection('fixture');
  value.reload(
    events.map((event, index) => ({
      ...event,
      meta: { id: `event-${index}`, at: '2026-11-09T00:00:00Z' },
    })) as MessageStreamEvent[],
    false,
  );
  return value;
}
function present(overrides: Partial<Parameters<typeof chatPresentation>[0]> = {}) {
  return chatPresentation({
    sessionId: 'fixture',
    snapshot: projection().snapshot(),
    ready: true,
    loading: false,
    historyError: '',
    connected: true,
    capabilities: { sessions: { send: true, cancel: true }, interaction: { respond: true } },
    sending: false,
    cancelling: false,
    firstSubmission: false,
    ...overrides,
  });
}

test('silent first submission affects presentation only and never enables an unconfirmed write', () => {
  const initial = { snapshot: null, ready: false, loading: true };
  expect(present(initial).activity?.text).toBe('正在读取会话…');
  const quiet = present({ ...initial, firstSubmission: true });
  expect(quiet.activity).toBeUndefined();
  expect(quiet.canSubmit).toBe(false);
  expect(quiet.canCancel).toBe(false);
  expect(quiet.canRespond).toBe(false);
});

test('cached display, pending synchronization, connection errors and closed sessions do not authorize sending', () => {
  expect(present({ ready: false }).canSubmit).toBe(false);
  expect(present({ loading: true }).canSubmit).toBe(false);
  expect(present({ connected: false }).canSubmit).toBe(false);
  expect(present({ historyError: 'read failed' }).canSubmit).toBe(false);
  const closed = projection();
  closed.unavailable('ended');
  expect(present({ snapshot: closed.snapshot() }).canSubmit).toBe(false);
  expect(present({ capabilities: {} }).canSubmit).toBe(false);
});

test('native active turns and independent background tasks retain different command affordances', () => {
  const history = projection([
    { type: 'turn.started', data: { turnId: 'turn', sequence: 0 } },
    {
      type: 'task.started',
      data: { turnId: 'turn', taskId: 'task', callId: 'call', kind: 'tool', name: 'fixture' },
    },
  ]);
  const active = present({ snapshot: history.snapshot() });
  expect(active.busy).toBe(true);
  expect(active.canSubmit).toBe(false);
  expect(active.canCancel).toBe(true);
  expect(active.activity).toBeUndefined();
  const cached = present({ snapshot: history.snapshot(), ready: false });
  expect(cached.canSubmit).toBe(false);
  expect(cached.canCancel).toBe(false);
  history.append(2, [
    {
      type: 'turn.completed',
      data: { turnId: 'turn', sequence: 0 },
      meta: { id: 'done', at: '2026-11-09T00:00:01Z' },
    },
  ]);
  const background = present({ snapshot: history.snapshot() });
  expect(background.busy).toBe(false);
  expect(background.backgroundBusy).toBe(true);
  expect(background.canSubmit).toBe(true);
  expect(background.activity?.text).toBe('后台任务执行中，可继续对话');
});
