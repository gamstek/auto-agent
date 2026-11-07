import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { MessageStreamEvent } from '@coraxjs/core/client';
import type { ChatSnapshot } from '@auto-agent/desktop-protocol';
import { native, desktop, errorText } from '../bridge';
import { reconcileChatSnapshot } from '../lib/chat-snapshot';
import { CoraxProjection } from '../lib/corax-projection';
import { chatTrace } from '../lib/chat-debug';
import { ChatHistoryCache, type CachedChatHistory } from '../lib/chat-history-cache';

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
  generation?: string;
  watchId: string;
  startIndex: number;
  events: MessageStreamEvent[];
  connectionError?: string;
  closed?: boolean;
  error?: string;
}

interface ViewLease {
  id: string;
  ready: Promise<void>;
  disposed: boolean;
  dirty: boolean;
  pending?: Promise<void>;
  confirmed: boolean;
}

function chatContext(id: string, cached?: CachedChatHistory) {
  return {
    id,
    projection: cached?.projection ?? new CoraxProjection(id),
    snapshot: (cached?.snapshot ?? null) as ChatSnapshot | null,
    watchId: '',
    loaded: !!cached,
    view: undefined as ViewLease | undefined,
    generation: cached?.generation ?? '',
    loading: !!id,
    error: '',
  };
}

/** Rust owns the authenticated stream; this hook owns only the official UI projection. */
export function useChat(sessionId: string, connected: boolean) {
  const [, render] = useState(0);
  const [identity, setIdentity] = useState(0);
  const cache = useRef(new ChatHistoryCache());
  const current = useRef(chatContext(''));
  if (current.current.id !== sessionId) {
    const previous = current.current;
    const cached = cache.current.take(sessionId);
    if (previous.loaded) cache.current.put(previous.projection, previous.generation);
    current.current = chatContext(sessionId, cached);
  }
  const notify = useCallback(() => render((value) => value + 1), []);
  // Called at backend/configuration boundaries, including deferred settings application.
  const clearHistory = useCallback(() => {
    cache.current.clear();
    current.current = chatContext(current.current.id);
    setIdentity((value) => value + 1);
  }, []);
  const notification = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Serialize only short lease commands, never history or stream network waits.
  const viewQueue = useRef(Promise.resolve());
  const queueView = useCallback((command: string, args: Record<string, unknown>) => {
    const operation = viewQueue.current.then(() => native<void>(command, args));
    viewQueue.current = operation.catch(() => {});
    return operation;
  }, []);

  const publish = useCallback(() => {
    const context = current.current;
    const next = context.projection.snapshot();
    context.snapshot = reconcileChatSnapshot(context.snapshot, next);
    notify();
  }, [notify]);

  const invalidate = useCallback(() => {
    const context = current.current;
    context.projection = new CoraxProjection(context.id);
    context.snapshot = null;
    context.loaded = false;
    context.generation = '';
    context.watchId = '';
    if (context.view) context.view.confirmed = false;
    notify();
  }, [notify]);

  const refresh = useCallback((): Promise<void> => {
    const context = current.current;
    const view = context.view;
    if (!context.id || !view || view.disposed) return Promise.resolve();
    const active = () => context === current.current && context.view === view && !view.disposed;
    context.loading = true;
    notify();
    view.dirty = true;
    if (view.pending) {
      chatTrace('chat-sync').mark('joined');
      return view.pending;
    }
    const trace = chatTrace('chat-sync', { loaded: context.loaded });
    view.pending = (async () => {
      try {
        await view.ready;
        while (view.dirty && active()) {
          view.dirty = false;
          const cursor = context.loaded ? context.projection.nextIndex : 0;
          const query =
            context.loaded && context.generation
              ? `?startIndex=${cursor}&generation=${encodeURIComponent(context.generation)}`
              : '';
          trace.mark('history', { cursor });
          const value = await native<EventSnapshot>('backend_request', {
            method: 'GET',
            path: `/session/${context.id}/events${query}`,
            body: null,
            viewId: view.id,
          });
          trace.mark('projection', {
            count: Array.isArray(value.events) ? value.events.length : 0,
          });
          if (!active()) return;
          if (
            value.sessionId !== context.id ||
            typeof value.generation !== 'string' ||
            !value.generation ||
            !Number.isSafeInteger(value.startIndex ?? 0) ||
            (value.startIndex ?? 0) < 0 ||
            !Array.isArray(value.events) ||
            value.revision !== (value.startIndex ?? 0) + value.events.length
          )
            throw new Error('Corax 会话快照格式无效。');
          const startIndex = value.startIndex ?? 0;
          if (context.generation && context.generation !== value.generation) cache.current.clear();
          if (
            startIndex !== 0 &&
            (!context.loaded || context.generation !== value.generation || startIndex !== cursor)
          ) {
            invalidate();
            // Only a read is repeated: rebuild an incompatible prefix from index zero.
            if (cursor === 0) throw new Error('Corax 会话快照缺少初始事件。');
            view.dirty = true;
            continue;
          }
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
          if (reset) {
            context.snapshot = context.projection.snapshot();
            notify();
          } else publish();
          trace.mark('watch', {
            reset,
            durationMs: Math.round(performance.now() - projectionStarted),
          });
          if (import.meta.env.DEV && performance.now() - projectionStarted > 250)
            console.debug('[chat-projection]', {
              elapsedMs: Math.round(performance.now() - projectionStarted),
              eventCount: value.events.length,
            });
          await native('backend_watch', {
            sessionId: context.id,
            startIndex: context.projection.nextIndex,
            watchId: context.watchId,
            viewId: view.id,
          });
          trace.mark('watched');
          if (active()) {
            context.error = '';
            view.confirmed = true;
          }
        }
      } catch (cause) {
        trace.mark(active() ? 'error' : 'cancelled');
        if (active()) {
          context.error = errorText(cause);
          view.confirmed = false;
        }
      } finally {
        view.pending = undefined;
        if (active()) {
          context.loading = false;
          notify();
        }
        trace.mark('end');
      }
    })();
    return view.pending;
  }, [publish, notify, invalidate]);

  useEffect(() => {
    const selected = current.current;
    selected.loading = !!sessionId;
    if (!desktop || !sessionId || !connected) {
      selected.loading = false;
      notify();
      return;
    }
    const viewId = crypto.randomUUID();
    const view: ViewLease = {
      id: viewId,
      ready: queueView('backend_chat_open', { sessionId, viewId }),
      disposed: false,
      dirty: false,
      confirmed: false,
    };
    selected.view = view;
    let disposed = false;
    const streamTrace = chatTrace('chat-stream');
    let received = false;
    let unlisten: (() => void) | undefined;
    void listen<EventBatch>('corax-events', ({ payload }) => {
      const context = current.current;
      if (disposed || context !== selected || context.view !== view) return;
      if (payload.sessionId !== context.id || payload.watchId !== context.watchId) return;
      if (payload.generation && payload.generation !== context.generation) {
        cache.current.clear();
        invalidate();
        void refresh();
        return;
      }
      if (!received && payload.events.length) {
        received = true;
        streamTrace.mark('first-event', { count: payload.events.length });
      }
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
        invalidate();
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
          selected.error = errorText(cause);
          selected.loading = false;
          notify();
        }
      });
    return () => {
      disposed = true;
      view.disposed = true;
      view.dirty = false;
      if (selected.view === view) selected.view = undefined;
      void queueView('backend_chat_close', { viewId }).catch(() => {});
      unlisten?.();
      if (notification.current) {
        clearTimeout(notification.current);
        notification.current = undefined;
      }
    };
  }, [sessionId, connected, identity, publish, refresh, queueView, notify, invalidate]);

  const context = current.current;
  return {
    snapshot: context.snapshot,
    loading: context.loading,
    error: context.error,
    ready:
      connected &&
      !!context.view?.confirmed &&
      !context.error &&
      !context.snapshot?.connectionError,
    refresh,
    clearHistory,
  };
}
