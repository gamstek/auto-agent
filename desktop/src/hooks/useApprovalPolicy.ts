import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalMode, DesktopApprovalSetting } from '@auto-agent/desktop-protocol';
import { api, errorText } from '../bridge';

/** One global backend choice; session navigation does not read or reset it. */
export function useApprovalPolicy(connected: boolean) {
  const [setting, setSetting] = useState<DesktopApprovalSetting>();
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const revision = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    const sequence = ++revision.current;
    setSetting(undefined);
    setError('');
    if (!connected) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void api<DesktopApprovalSetting>('/approval')
      .then((value) => {
        if (sequence === revision.current) setSetting(value);
      })
      .catch((cause) => {
        if (sequence === revision.current) setError(errorText(cause));
      })
      .finally(() => {
        if (sequence === revision.current) setLoading(false);
      });
    return () => {
      revision.current++;
    };
  }, [connected, reload]);
  const change = useCallback(
    async (mode: ApprovalMode) => {
      if (lock.current || !connected || !setting || setting.mode === mode) return;
      lock.current = true;
      setUpdating(true);
      setError('');
      const sequence = revision.current;
      try {
        const value = await api<DesktopApprovalSetting>('/approval', 'POST', { ...setting, mode });
        if (sequence === revision.current) setSetting(value);
      } catch (cause) {
        if (sequence === revision.current) {
          setError(errorText(cause));
          setSetting(undefined);
        }
      } finally {
        lock.current = false;
        setUpdating(false);
      }
    },
    [connected, setting],
  );
  const invalidate = useCallback(() => setReload((value) => value + 1), []);
  return {
    mode: setting?.mode,
    loading,
    updating,
    error,
    change,
    ready: connected && !!setting && !loading && !updating,
    refresh: invalidate,
    invalidate,
  };
}
