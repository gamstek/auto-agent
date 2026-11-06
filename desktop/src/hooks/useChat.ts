import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { MessageStreamEvent } from '@coraxjs/core/client';
import type { ChatSnapshot } from '@auto-agent/desktop-protocol';
import { api, native, desktop, errorText } from '../bridge';
import { reconcileChatSnapshot } from '../lib/chat-snapshot';
import { CoraxProjection } from '../lib/corax-projection';

interface EventSnapshot {
  sessionId: string;
  generation: string;
  startIndex?: number;
  revision: number;
  admitted: boolean;
  events: MessageStreamEvent[];
}
interface EventBatch {
  sessionId: string;
  watchId: string;
  startIndex: number;
  events: MessageStreamEvent[];
  connectionError?: string;
  closed?: boolean;
  error?: string;
}

/** Rust owns the authenticated stream; this hook owns only the official UI projection. */
export function useChat(sessionId: string, connected: boolean) {
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const current = useRef({
    id: '',
    projection: new CoraxProjection(''),
    watchId: '',
    loaded: false,
    dirty: false,
    pending: undefined as Promise<void> | undefined,
    generation: '',
  });
  if (current.current.id !== sessionId)
    current.current = {
      id: sessionId,
      projection: new CoraxProjection(sessionId),
      watchId: '',
      loaded: false,
      dirty: false,
      pending: undefined,
      generation: '',
    };
  const notification = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const publish = useCallback(() => {
    const context = current.current;
    const next = context.projection.snapshot();
    setSnapshot((previous) => reconcileChatSnapshot(previous, next));
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const context = current.current;
    if (!context.id) return Promise.resolve();
    setLoading(true);
    context.dirty = true;
    if (context.pending) return context.pending;
    context.pending = (async () => {
      try {
        while (context.dirty && context === current.current) {
          context.dirty = false;
          const cursor = context.loaded ? context.projection.nextIndex : 0;
          const query =
            context.loaded && context.generation
              ? `?startIndex=${cursor}&generation=${encodeURIComponent(context.generation)}`
              : '';
          const value = await api<EventSnapshot>(`/session/${context.id}/events${query}`);
          if (context !== current.current) return;
          if (
            value.sessionId !== context.id ||
            !Array.isArray(value.events) ||
            value.revision !== (value.startIndex ?? 0) + value.events.length
          )
            throw new Error('Corax 会话快照格式无效。');
          const startIndex = value.startIndex ?? 0;
          const reset =
            !context.loaded || context.generation !== value.generation || startIndex === 0;
          const projectionStarted = performance.now();
          if (reset) {
            if (startIndex !== 0) throw new Error('Corax 会话快照缺少初始事件。');
            context.projection.reload(value.events, value.admitted);
          } else {
            context.projection.append(startIndex, value.events);
            context.projection.admission(value.admitted, value.revision);
          }
          context.generation = value.generation;
          context.watchId = crypto.randomUUID();
          context.loaded = true;
          if (reset) setSnapshot(context.projection.snapshot());
          else publish();
          if (import.meta.env.DEV && performance.now() - projectionStarted > 250)
            console.debug('[chat-projection]', {
              elapsedMs: Math.round(performance.now() - projectionStarted),
              eventCount: value.events.length,
            });
          await native('backend_watch', {
            sessionId: context.id,
            startIndex: context.projection.nextIndex,
            watchId: context.watchId,
          });
          setError('');
        }
      } catch (cause) {
        if (context === current.current) setError(errorText(cause));
      } finally {
        context.pending = undefined;
        if (context === current.current) setLoading(false);
      }
    })();
    return context.pending;
  }, [publish]);

  useEffect(() => {
    setSnapshot(null);
    setError('');
  }, [sessionId]);
  useEffect(() => {
    setLoading(!!sessionId);
    if (!desktop || !sessionId || !connected) {
      setLoading(false);
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<EventBatch>('corax-events', ({ payload }) => {
      const context = current.current;
      if (payload.sessionId !== context.id || payload.watchId !== context.watchId) return;
      try {
        context.projection.append(payload.startIndex, payload.events);
        if (payload.closed)
          context.projection.unavailable(payload.error ?? '会话不可继续，请新建会话。');
        else context.projection.disconnected(payload.connectionError);
        notification.current ??= setTimeout(() => {
          notification.current = undefined;
          publish();
        }, 40);
      } catch {
        void refresh();
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else {
          unlisten = stop;
          void refresh();
        }
      })
      .catch((cause) => {
        if (!disposed) {
          setError(errorText(cause));
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
      unlisten?.();
      if (notification.current) {
        clearTimeout(notification.current);
        notification.current = undefined;
      }
    };
  }, [sessionId, connected, publish, refresh]);

  return { snapshot: snapshot?.sessionId === sessionId ? snapshot : null, loading, error, refresh };
}
