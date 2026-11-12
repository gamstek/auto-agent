import type { MessageStreamEvent } from '@coraxjs/core/client';
import { CoraxProjection } from './corax-projection';
import { yieldToHost } from './yield-to-host';

// Real installed histories contained hundreds of streaming events per turn: 128 often
// had no boundary. Start at 512 and avoid competing with a concurrent full read.
export const HISTORY_TAIL_WINDOWS = [512, 2048] as const;

/** Let the UI process the published preview before beginning canonical synchronization. */
export function yieldForHistoryPreview() {
  return yieldToHost();
}

/** Display-only projection; never a source of readiness, activity or write admission. */
export async function projectHistoryTail(
  id: string,
  events: readonly MessageStreamEvent[],
  current = () => true,
) {
  const cleared = events.reduce(
    (last, event, index) => (event.type === 'context.cleared' ? index : last),
    -1,
  );
  if (cleared >= 0) events = events.slice(cleared + 1);
  const first = events.findIndex((event) => event.type === 'turn.started');
  if (first < 0) {
    // A long turn may exceed every bounded window. A real completed reply already
    // carries its complete text; do not synthesize a turn or replay dangling tool deltas.
    const completed = events.filter(
      (event): event is Extract<MessageStreamEvent, { type: 'message.completed' }> =>
        event.type === 'message.completed' &&
        typeof event.data.message === 'string' &&
        !!event.data.message &&
        event.data.finishReason !== 'tool-calls' &&
        event.data.finishReason !== 'other',
    );
    const last = completed.reduce<(typeof completed)[number] | undefined>(
      (latest, event) => (!latest || event.data.sequence >= latest.data.sequence ? event : latest),
      undefined,
    );
    if (!last) return null;
    const projection = new CoraxProjection(id);
    if (!(await projection.catchUp(0, [last], false, current))) return null;
    return { snapshot: projection.snapshot(), kind: 'reply' as const };
  }
  const turns = new Set(
    events
      .slice(first)
      .flatMap((event) => (event.type === 'turn.started' ? [event.data.turnId] : [])),
  );
  const segment = events.slice(first).filter((event) => {
    const turnId = (event.data as { turnId?: string }).turnId;
    return turnId
      ? turns.has(turnId)
      : event.type.startsWith('session.') || event.type === 'context.cleared';
  });
  const projection = new CoraxProjection(id);
  if (!(await projection.catchUp(0, segment, false, current))) return null;
  const snapshot = projection.snapshot();
  return snapshot.conversation.messages.length ? { snapshot, kind: 'turns' as const } : null;
}
