import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { BackendCapabilities } from '@auto-agent/desktop-protocol';
import {
  api,
  assertDesktopProtocol,
  desktop,
  errorText,
  isAgentEvent,
  native,
  type BackendHealth,
  type ServiceEvent,
  type Session,
} from '../bridge';

export type BackendConnectionState = 'starting' | 'connected' | 'disconnected';

/** Native backend startup and transport notifications; no chat dispatch or model generation. */
export function useBackendLifecycle({
  currentSessionId,
  selectSession,
  syncSession,
  resetHistory,
  refreshSessions,
  onConnectionChange,
  onCapabilities,
  onError,
}: {
  currentSessionId: RefObject<string>;
  selectSession: (id: string) => void;
  syncSession: () => Promise<void>;
  resetHistory: () => void;
  refreshSessions: () => Promise<Session[]>;
  onConnectionChange: (connection: BackendConnectionState) => void;
  onCapabilities: (capabilities: BackendCapabilities) => void;
  onError: (message: string) => void;
}) {
  const [initialized, setInitialized] = useState(false);
  const [identity, setIdentity] = useState(0);
  const [booting, setBooting] = useState(true);
  const [bootStage, setBootStage] = useState<'server' | 'workspace'>('server');
  const bootLock = useRef(false);
  const invalidate = useCallback(() => {
    resetHistory();
    setIdentity((value) => value + 1);
  }, [resetHistory]);
  const boot = useCallback(async () => {
    if (bootLock.current) return;
    bootLock.current = true;
    invalidate();
    setBooting(true);
    setBootStage('server');
    onConnectionChange('starting');
    onError('');
    try {
      await native('backend_start');
      const health = await api<BackendHealth>('/global/health');
      assertDesktopProtocol(health);
      onCapabilities(health.capabilities ?? {});
      setBootStage('workspace');
      const list = await refreshSessions();
      const previous = localStorage.getItem('last-session');
      if (currentSessionId.current) await syncSession();
      else if (previous && list.some((session) => session.id === previous)) selectSession(previous);
      onConnectionChange('connected');
      setInitialized(true);
    } catch (error) {
      onConnectionChange('disconnected');
      onError(errorText(error));
    } finally {
      bootLock.current = false;
      setBooting(false);
    }
  }, [
    invalidate,
    onConnectionChange,
    onError,
    onCapabilities,
    refreshSessions,
    currentSessionId,
    syncSession,
    selectSession,
  ]);
  useEffect(() => {
    if (!desktop) {
      setBooting(false);
      onConnectionChange('disconnected');
      onError('请运行 pnpm dev:desktop，通过桌面应用连接本地 Corax 服务。');
      return;
    }
    let disposed = false;
    const cleanup: (() => void)[] = [];
    void (async () => {
      const events = await listen<ServiceEvent>('agent-event', ({ payload: event }) => {
        if (!isAgentEvent(event)) return;
        if (event.type === 'session.updated') void refreshSessions().catch(() => {});
        if (event.sessionId !== currentSessionId.current) return;
        if (event.type === 'session.error') {
          onError(String(event.properties.message ?? '请求失败'));
          void syncSession().catch(() => {});
        }
      });
      const streams = await listen<string>('backend-stream', ({ payload }) => {
        if (bootLock.current) return;
        setIdentity((value) => value + 1);
        if (payload === 'connected') {
          resetHistory();
          void api<BackendHealth>('/global/health')
            .then((health) => {
              assertDesktopProtocol(health);
              onCapabilities(health.capabilities ?? {});
              onConnectionChange('connected');
              void syncSession().catch(() => {});
              void refreshSessions().catch(() => {});
            })
            .catch((error) => {
              onConnectionChange('disconnected');
              onError(errorText(error));
            });
        } else onConnectionChange('disconnected');
      });
      if (disposed) {
        events();
        streams();
        return;
      }
      cleanup.push(events, streams);
      await boot();
    })().catch((error) => {
      if (!disposed) {
        setBooting(false);
        onConnectionChange('disconnected');
        onError(errorText(error));
      }
    });
    return () => {
      disposed = true;
      cleanup.forEach((off) => off());
    };
  }, [
    boot,
    currentSessionId,
    onCapabilities,
    onConnectionChange,
    onError,
    refreshSessions,
    resetHistory,
    syncSession,
  ]);
  const settingsSaved = useCallback(
    (applied: boolean) => {
      if (applied) void boot();
      else invalidate();
    },
    [boot, invalidate],
  );
  return { initialized, identity, booting, bootStage, boot, settingsSaved };
}
