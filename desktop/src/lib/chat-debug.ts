import { desktop, native } from '../bridge';

type Operation = 'send' | 'chat-sync' | 'session-list' | 'chat-state' | 'chat-stream';
type Stage =
  | 'begin'
  | 'end'
  | 'create'
  | 'created'
  | 'submit'
  | 'accepted'
  | 'sync'
  | 'synced'
  | 'list'
  | 'listed'
  | 'error'
  | 'cancelled'
  | 'joined'
  | 'history'
  | 'projection'
  | 'watch'
  | 'watched'
  | 'page'
  | 'state'
  | 'first-event';
type Details = Partial<{
  count: number;
  cursor: number;
  reset: boolean;
  loaded: boolean;
  sending: boolean;
  loading: boolean;
  busy: boolean;
  connected: boolean;
  initial: boolean;
  durationMs: number;
  success: boolean;
}>;

let nextTrace = 0;

/** Fire-and-forget metadata only; timing collection must not delay chat operations. */
export function chatTrace(operation: Operation, details: Details = {}) {
  const started = performance.now();
  const trace = ++nextTrace;
  const mark = (stage: Stage, fields: Details = {}) => {
    if (!import.meta.env.DEV || !desktop) return;
    void native('frontend_debug', {
      operation,
      stage,
      trace,
      elapsedMs: Math.round(performance.now() - started),
      details: fields,
    }).catch(() => {});
  };
  mark('begin', details);
  return { mark };
}
