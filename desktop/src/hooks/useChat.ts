import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { MessageStreamEvent } from '@coraxjs/core/client';
import type { ChatSnapshot } from '@auto-agent/desktop-protocol';
import { native, desktop, errorText } from '../bridge';
import { reconcileChatSnapshot } from '../lib/chat-snapshot';
import { CoraxProjection } from '../lib/corax-projection';
import { chatTrace } from '../lib/chat-debug';
import { ChatHistoryCache, type CachedChatHistory } from '../lib/chat-history-cache';
import {
  HISTORY_TAIL_WINDOWS,
  yieldForHistoryPreview,
  projectHistoryTail,
} from '../lib/history-tail';

interface EventSnapshot {
  sessionId: string;
  generation: string;
  startIndex: number;
  revision: number;
  admitted: boolean;
  events: MessageStreamEvent[];
  preview?: boolean;
  complete?: boolean;
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
  const preview = cached?.preview;
  return {
    id,
    projection: cached?.projection ?? new CoraxProjection(id),
    snapshot: (preview ? null : (cached?.snapshot ?? null)) as ChatSnapshot | null,
    preview: (preview ? cached.snapshot : null) as ChatSnapshot | null,
    previewGeneration: preview ? cached.generation : '',
    previewStartIndex: preview?.startIndex ?? 0,
    previewKind: preview?.kind ?? ('turns' as 'turns' | 'reply'),
    watchId: '',
    loaded: !!cached && !preview,
    view: undefined as ViewLease | undefined,
    generation: preview ? '' : (cached?.generation ?? ''),
    loading: !!id,
    error: '',
  };
}

/** Rust owns the authenticated stream; this hook owns only the official UI projection. */
export function useChat(sessionId: string, connected: boolean, allowPreview = true) {
  const [, render] = useState(0);
  const [identity, setIdentity] = useState(0);
  const cache = useRef(new ChatHistoryCache());
  const current = useRef(chatContext(''));
  const previewAllowed = useRef(allowPreview);
  previewAllowed.current = allowPreview;
  if (current.current.id !== sessionId) {
    const previous = current.current;
    const cached = cache.current.take(sessionId);
    if (previous.loaded) cache.current.put(previous.projection, previous.generation);
    else if (previous.preview)
      cache.current.putPreview(
        previous.preview,
        previous.previewGeneration,
        previous.previewStartIndex,
        previous.previewKind,
      );
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
    context.preview = null;
    context.previewGeneration = '';
    context.previewStartIndex = 0;
    context.loaded = false;
    context.generation = '';
    context.watchId = '';
    if (context.view) context.view.confirmed = false;
    notify();
  }, [notify]);

  const refresh = useCallback(
    (initial?: EventSnapshot): Promise<void> => {
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
            const value =
              initial ??
              (await native<EventSnapshot>('backend_request', {
                method: 'GET',
                path: `/session/${context.id}/events${query}`,
                body: null,
                viewId: view.id,
              }));
            initial = undefined;
            trace.mark('projection', {
              count: Array.isArray(value.events) ? value.events.length : 0,
            });
            if (!active()) return;
            if (
              value.sessionId !== context.id ||
              typeof value.generation !== 'string' ||
              !value.generation ||
              !Number.isSafeInteger(value.startIndex) ||
              value.startIndex < 0 ||
              !Array.isArray(value.events) ||
              value.preview === true ||
              !Number.isSafeInteger(value.revision) ||
              value.revision !== value.startIndex + value.events.length
            )
              throw new Error('Corax 会话快照格式无效。');
            const startIndex = value.startIndex;
            if (context.previewGeneration && context.previewGeneration !== value.generation) {
              context.preview = null;
              context.previewGeneration = '';
              context.previewStartIndex = 0;
              cache.current.clear();
            }
            if (context.generation && context.generation !== value.generation)
              cache.current.clear();
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
              view.confirmed = false;
              context.loaded = false;
              context.generation = value.generation;
              context.snapshot = null;
              notify();
            }
            const projection = context.projection;
            const completed = await projection.catchUp(
              startIndex,
              value.events,
              value.admitted,
              () => active() && context.projection === projection,
            );
            if (!active()) return;
            if (!completed) {
              view.dirty = true;
              continue;
            }
            context.generation = value.generation;
            context.watchId = crypto.randomUUID();
            context.loaded = true;
            context.preview = null;
            context.previewGeneration = '';
            context.previewStartIndex = 0;
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
    },
    [publish, notify, invalidate],
  );

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
    const preview = async () => {
      if (!previewAllowed.current || selected.loaded || selected.preview) return;
      const trace = chatTrace('chat-sync', { initial: true });
      const active = () =>
        !disposed &&
        current.current === selected &&
        selected.view === view &&
        !view.disposed &&
        !selected.loaded;
      try {
        await view.ready;
        for (const count of HISTORY_TAIL_WINDOWS) {
          if (!active()) return;
          trace.mark('history', { count });
          const value = await native<EventSnapshot>('backend_request', {
            method: 'GET',
            path: `/session/${sessionId}/events?tail=${count}`,
            body: null,
            viewId,
          });
          if (!active()) return;
          if (
            value.sessionId !== sessionId ||
            typeof value.generation !== 'string' ||
            !value.generation ||
            !Number.isSafeInteger(value.startIndex) ||
            value.startIndex < 0 ||
            !Array.isArray(value.events) ||
            value.events.length > count ||
            !Number.isSafeInteger(value.revision) ||
            value.revision !== value.startIndex + value.events.length
          )
            return;
          if (
            value.complete === true &&
            value.preview === false &&
            value.startIndex === 0 &&
            (value.events.length === 0 || value.events[0]?.type === 'session.started')
          )
            return value;
          if (value.preview !== true) return;
          const isCurrentPreview = () =>
            active() && (!selected.generation || selected.generation === value.generation);
          const projection = await projectHistoryTail(sessionId, value.events, isCurrentPreview);
          if (!isCurrentPreview()) return;
          if (projection) {
            trace.mark('projection', { count: value.events.length });
            selected.preview = projection.snapshot;
            selected.previewKind = projection.kind;
            selected.previewGeneration = value.generation;
            selected.previewStartIndex = value.startIndex;
            notify();
            return;
          }
          if (value.startIndex === 0) return;
        }
      } catch {
        // A preview is optional; canonical synchronization reports actual read failures.
        trace.mark('error');
      } finally {
        trace.mark('end');
      }
    };
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
          void (async () => {
            const cold = !selected.loaded;
            const initial = await preview();
            if (disposed || current.current !== selected || selected.view !== view || view.disposed)
              return;
            if (cold && selected.loaded) return;
            if (selected.preview) await yieldForHistoryPreview();
            if (disposed || current.current !== selected || selected.view !== view || view.disposed)
              return;
            await refresh(initial);
          })();
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
    snapshot: context.snapshot ?? context.preview,
    loading: context.loading,
    previewingOlder:
      context.loading && !context.loaded && !!context.preview && context.previewStartIndex > 0,
    replyPreview: !context.loaded && !!context.preview && context.previewKind === 'reply',
    error: context.error,
    ready:
      connected &&
      context.loaded &&
      !!context.view?.confirmed &&
      !context.error &&
      !context.snapshot?.connectionError,
    refresh,
    clearHistory,
  };
}
