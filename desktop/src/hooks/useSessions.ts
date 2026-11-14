import { useCallback, useRef, useState } from 'react';
import { api, errorText, type Session } from '../bridge';
import { chatTrace } from '../lib/chat-debug';

const PAGE_SIZE = 50;

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const cursor = useRef(0);
  const more = useRef(false);
  const fetching = useRef(false);
  const epoch = useRef(0);
  const refreshPromise = useRef<Promise<Session[]> | null>(null);
  const titleRevision = useRef(0);
  const titleChanges = useRef(new Map<string, { revision: number; title: string }>());
  const mergeTitles = (rows: Session[], started: number) =>
    rows.map((row) => {
      const change = titleChanges.current.get(row.id);
      return change && change.revision > started ? { ...row, title: change.title } : row;
    });

  const refreshSessions = useCallback((): Promise<Session[]> => {
    if (refreshPromise.current) {
      chatTrace('session-list').mark('joined');
      return refreshPromise.current;
    }
    const trace = chatTrace('session-list');
    const request = ++epoch.current;
    const titlesStarted = titleRevision.current;
    const count = Math.max(PAGE_SIZE, cursor.current);
    fetching.current = true;
    setLoading(true);
    setError('');
    const promise = (async () => {
      try {
        // Refresh the loaded window, not just page one: title/run events must not
        // discard older sessions or leave an offset pointing into a reordered list.
        const rows: Session[] = [];
        let batch: Session[];
        do {
          trace.mark('page', { cursor: rows.length });
          batch = await api<Session[]>(`/session?limit=${PAGE_SIZE}&offset=${rows.length}`);
          rows.push(...batch);
        } while (batch.length === PAGE_SIZE && rows.length < count);
        const mergedRows = mergeTitles(
          [...new Map(rows.map((session) => [session.id, session])).values()],
          titlesStarted,
        );
        if (request === epoch.current) {
          cursor.current = rows.length;
          more.current = batch.length === PAGE_SIZE;
          setHasMore(more.current);
          setSessions(mergedRows);
          for (const [id, change] of titleChanges.current)
            if (change.revision <= titlesStarted) titleChanges.current.delete(id);
        }
        return mergedRows;
      } catch (cause) {
        trace.mark('error');
        if (request === epoch.current) setError(errorText(cause));
        throw cause;
      } finally {
        if (request === epoch.current) {
          fetching.current = false;
          setLoading(false);
        }
        refreshPromise.current = null;
        trace.mark('end');
      }
    })();
    refreshPromise.current = promise;
    return promise;
  }, []);

  const loadMore = useCallback(async () => {
    if (fetching.current || !more.current) return;
    const request = epoch.current;
    const titlesStarted = titleRevision.current;
    const offset = cursor.current;
    fetching.current = true;
    setLoading(true);
    setError('');
    try {
      const batch = await api<Session[]>(`/session?limit=${PAGE_SIZE}&offset=${offset}`);
      if (request !== epoch.current) return;
      cursor.current = offset + batch.length;
      more.current = batch.length === PAGE_SIZE;
      setHasMore(more.current);
      setSessions((previous) => {
        const merged = new Map(previous.map((session) => [session.id, session]));
        for (const session of mergeTitles(batch, titlesStarted)) merged.set(session.id, session);
        return [...merged.values()];
      });
    } catch (cause) {
      if (request === epoch.current) setError(errorText(cause));
    } finally {
      if (request === epoch.current) {
        fetching.current = false;
        setLoading(false);
      }
    }
  }, []);

  const renameSession = useCallback(async (id: string, title: string) => {
    const value = await api<{ id: string; title: string }>(`/session/${id}/title`, 'PATCH', {
      title,
    });
    if (value.id !== id || typeof value.title !== 'string' || !value.title.trim())
      throw new Error('重命名响应无效，请刷新会话列表核对结果。');
    titleChanges.current.set(id, { revision: ++titleRevision.current, title: value.title });
    // Bound transient receipts; titles themselves are persisted only by Corax.
    while (titleChanges.current.size > 100)
      titleChanges.current.delete(titleChanges.current.keys().next().value!);
    setSessions((rows) =>
      rows.map((row) => (row.id === id ? { ...row, title: value.title } : row)),
    );
  }, []);

  return { sessions, loading, hasMore, error, refreshSessions, loadMore, renameSession };
}
