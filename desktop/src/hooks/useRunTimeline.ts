import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../bridge';
import type { RunTimelineData, ToolCallDetail } from '../types/run-timeline';

interface ReadOptions<T> {
  path: string;
  enabled: boolean;
  pollMs?: number;
  revision?: string;
  validate?: (value: T) => void;
}

/** Read-only, serial polling; stale replies cannot cross run or entry boundaries. */
function useRunResource<T>({ path, enabled, pollMs, revision, validate }: ReadOptions<T>) {
  const [result, setResult] = useState<{ path: string; data: T; serialized: string } | null>(null);
  const [failure, setFailure] = useState<{ path: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let pending = false;
    async function read() {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        const data = await api<T>(path);
        validate?.(data);
        if (disposed) return;
        const serialized = JSON.stringify(data);
        setResult((previous) =>
          previous?.path === path && previous.serialized === serialized
            ? previous
            : { path, data, serialized },
        );
        setFailure(null);
      } catch (error) {
        if (!disposed) setFailure({ path, message: errorText(error) });
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    }
    void read();
    const timer = pollMs ? setInterval(() => void read(), pollMs) : undefined;
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [path, enabled, pollMs, revision, validate, attempt]);

  return {
    data: result?.path === path ? result.data : null,
    error: failure?.path === path ? failure.message : '',
    loading,
    reload,
  };
}

function validateTimeline(value: RunTimelineData) {
  if (!Array.isArray(value.entries))
    throw new Error('当前后端尚未支持完整对话过程，请更新配套后端。');
}

export function useRunTimeline(
  sessionId: string,
  runId: string,
  running: boolean,
  visible: boolean,
) {
  return useRunResource<RunTimelineData>({
    path: `/session/${sessionId}/runs/${runId}/trace?view=process`,
    enabled: visible,
    pollMs: running ? 250 : undefined,
    validate: validateTimeline,
  });
}

export function useToolCallDetail(
  sessionId: string,
  runId: string,
  entryId: string,
  status: string,
  enabled: boolean,
) {
  return useRunResource<ToolCallDetail>({
    path: `/session/${sessionId}/runs/${runId}/trace?entry=${encodeURIComponent(entryId)}`,
    enabled,
    revision: status,
  });
}
