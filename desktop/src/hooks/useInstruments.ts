import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api, desktop, errorText, type ServiceEvent } from '../bridge';
import type { InstrumentSnapshot } from '../types/instrument';

type Mode = 'refresh' | 'snapshot';

export function useInstruments(active = true) {
  const [devices, setDevices] = useState<InstrumentSnapshot[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(active);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!active) {
      refresh.current = () => {};
      setLoading(false);
      setDevices((previous) => previous.map((device) => ({ ...device, stale: true })));
      return;
    }
    let disposed = false,
      inFlight = false,
      failures = 0;
    let queued: Mode | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listeners: (() => void)[] = [];
    function clearTimer() {
      clearTimeout(timer);
      timer = undefined;
    }
    function request(mode: Mode) {
      if (disposed || document.hidden) return;
      if (inFlight) {
        if (queued !== 'refresh') queued = mode;
        return;
      }
      void update(mode);
    }
    async function update(mode: Mode) {
      inFlight = true;
      if (mode === 'refresh') clearTimer();
      setLoading(true);
      try {
        const listed = await api<InstrumentSnapshot[]>('/devices');
        if (disposed) return;
        setDevices(listed);
        if (mode === 'refresh' && !document.hidden) {
          const snapshots = await Promise.all(
            listed.map((device) =>
              api<InstrumentSnapshot>(`/devices/${device.deviceId}/refresh`, 'POST', {}),
            ),
          );
          if (disposed) return;
          setDevices(snapshots);
          failures = snapshots.some((device) => device.error) ? failures + 1 : 0;
        }
        setError('');
      } catch (cause) {
        if (!disposed) {
          setError(errorText(cause));
          setDevices((previous) => previous.map((device) => ({ ...device, stale: true })));
          failures++;
          clearTimer();
        }
      } finally {
        inFlight = false;
        if (!disposed) {
          setLoading(false);
          if (!document.hidden && timer === undefined)
            timer = setTimeout(
              () => {
                timer = undefined;
                request('refresh');
              },
              Math.min(30000, 3000 * 2 ** Math.min(failures, 4)),
            );
          const next = queued;
          queued = undefined;
          if (next) request(next);
        }
      }
    }
    refresh.current = () => request('refresh');
    const visibility = () => {
      clearTimer();
      if (!document.hidden) request('refresh');
    };
    document.addEventListener('visibilitychange', visibility);
    if (desktop) {
      const attach = (promise: Promise<() => void>) => {
        void promise
          .then((off) => {
            if (disposed) off();
            else listeners.push(off);
          })
          .catch(() => {
            // Polling remains the fallback if the native event subscription is unavailable.
          });
      };
      attach(
        listen<ServiceEvent>('agent-event', ({ payload }) => {
          if (
            payload.type === 'extension.changed' &&
            payload.properties?.extension === 'instruments'
          )
            request('snapshot');
        }),
      );
      attach(
        listen<string>('backend-stream', ({ payload }) => {
          if (payload === 'connected') {
            failures = 0;
            clearTimer();
            request('snapshot');
          }
        }),
      );
    }
    request('refresh');
    return () => {
      disposed = true;
      clearTimer();
      listeners.forEach((off) => off());
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [active]);
  return { devices, error, loading, refresh: () => refresh.current() };
}
