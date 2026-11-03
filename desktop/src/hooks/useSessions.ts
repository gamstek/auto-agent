import { useCallback, useRef, useState } from 'react';
import { api, errorText, type Session } from '../bridge';

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

  const refreshSessions = useCallback((): Promise<Session[]> => {
    if (refreshPromise.current) return refreshPromise.current;
    const request = ++epoch.current;
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
          batch = await api<Session[]>(`/session?limit=${PAGE_SIZE}&offset=${rows.length}`);
          rows.push(...batch);
        } while (batch.length === PAGE_SIZE && rows.length < count);
        if (request === epoch.current) {
          cursor.current = rows.length;
          more.current = batch.length === PAGE_SIZE;
          setHasMore(more.current);
          setSessions([...new Map(rows.map((session) => [session.id, session])).values()]);
        }
        return rows;
      } catch (cause) {
        if (request === epoch.current) setError(errorText(cause));
        throw cause;
      } finally {
        if (request === epoch.current) {
          fetching.current = false;
          setLoading(false);
        }
        refreshPromise.current = null;
      }
    })();
    refreshPromise.current = promise;
    return promise;
  }, []);

  const loadMore = useCallback(async () => {
    if (fetching.current || !more.current) return;
    const request = epoch.current;
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
        for (const session of batch) merged.set(session.id, session);
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

  return { sessions, loading, hasMore, error, refreshSessions, loadMore };
}
