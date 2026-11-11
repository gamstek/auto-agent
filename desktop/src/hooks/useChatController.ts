import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendCapabilities, InputResponse } from '@auto-agent/desktop-protocol';
import { api, errorText, sendErrorText, type Session } from '../bridge';
import { chatTrace } from '../lib/chat-debug';
import { chatPresentation } from '../lib/chat-presentation';
import { useChat } from './useChat';

type SelectedView = { id: string; origin: 'history' | 'first-submission' };

/** Frontend selection, commands and transient feedback. Corax still owns all run state. */
export function useChatController({
  connected,
  capabilities,
  refreshSessions,
  onError,
  onNavigate,
  onSend,
}: {
  connected: boolean;
  capabilities: BackendCapabilities;
  refreshSessions: () => Promise<Session[]>;
  onError: (message: string) => void;
  onNavigate: (fresh: boolean) => void;
  onSend: () => void;
}) {
  const [view, setView] = useState<SelectedView>({ id: '', origin: 'history' });
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const sessionIdRef = useRef('');
  const navigationEpoch = useRef(0);
  const requestLock = useRef(false);
  const history = useChat(view.id, connected);
  const state = chatPresentation({
    sessionId: view.id,
    snapshot: history.snapshot,
    ready: history.ready,
    loading: history.loading,
    historyError: history.error,
    connected,
    capabilities,
    sending,
    cancelling,
    firstSubmission: view.origin === 'first-submission',
  });
  const firstAssistantObserved =
    view.origin === 'first-submission' &&
    state.messages.some((message) => message.role === 'assistant');
  const settleFirstSubmission = useCallback(() => {
    setView((previous) =>
      previous.origin === 'history' ? previous : { ...previous, origin: 'history' },
    );
  }, []);
  useEffect(() => {
    if (
      firstAssistantObserved ||
      history.error ||
      history.snapshot?.error ||
      history.snapshot?.connectionError ||
      !connected
    )
      settleFirstSubmission();
  }, [
    view.origin,
    firstAssistantObserved,
    history.error,
    history.snapshot?.error,
    history.snapshot?.connectionError,
    connected,
    settleFirstSubmission,
  ]);
  useEffect(() => {
    if (!state.busy) setCancelling(false);
  }, [state.busy]);
  useEffect(() => {
    chatTrace('chat-state').mark('state', {
      sending,
      loading: history.loading,
      busy: state.busy,
      connected,
    });
  }, [sending, history.loading, state.busy, connected]);

  const select = useCallback(
    (id: string) => {
      navigationEpoch.current++;
      sessionIdRef.current = id;
      setView({ id, origin: 'history' });
      setCancelling(false);
      onError('');
      localStorage.setItem('last-session', id);
      onNavigate(false);
    },
    [onError, onNavigate],
  );
  const newSession = useCallback(() => {
    navigationEpoch.current++;
    sessionIdRef.current = '';
    setView({ id: '', origin: 'history' });
    setCancelling(false);
    setInput('');
    onError('');
    localStorage.removeItem('last-session');
    onNavigate(true);
  }, [onError, onNavigate]);
  const resetHistory = useCallback(() => {
    history.clearHistory();
    settleFirstSubmission();
  }, [history.clearHistory, settleFirstSubmission]);

  async function send(text = input) {
    if (!text.trim() || requestLock.current || !state.canSubmit) return;
    requestLock.current = true;
    setSending(true);
    onError('');
    onSend();
    const epoch = navigationEpoch.current;
    const trace = chatTrace('send', { initial: !sessionIdRef.current });
    try {
      let id = sessionIdRef.current;
      if (!id) {
        trace.mark('create');
        const session = await api<Session>('/session', 'POST', {});
        trace.mark('created');
        id = session.id;
        if (navigationEpoch.current === epoch) {
          sessionIdRef.current = id;
          setView({ id, origin: 'first-submission' });
          localStorage.setItem('last-session', id);
        }
      }
      trace.mark('submit');
      await api(`/session/${id}/prompt_async`, 'POST', { content: text.trim() });
      trace.mark('accepted');
      setSending(false);
      if (navigationEpoch.current === epoch) {
        setInput('');
        trace.mark('sync');
        await history.refresh();
        trace.mark('synced');
      }
      trace.mark('list');
      void refreshSessions()
        .then(() => trace.mark('listed'))
        .catch(() => {});
    } catch (error) {
      trace.mark('error');
      if (navigationEpoch.current === epoch) {
        settleFirstSubmission();
        onError(sendErrorText(error));
      }
      await history.refresh().catch(() => {});
    } finally {
      requestLock.current = false;
      setSending(false);
      trace.mark('end');
    }
  }
  async function cancel() {
    if (!state.canCancel) return;
    const id = sessionIdRef.current,
      epoch = navigationEpoch.current;
    setCancelling(true);
    try {
      const result = await api<{ status: string }>(`/session/${id}/abort`, 'POST', {});
      if (sessionIdRef.current !== id || navigationEpoch.current !== epoch) return;
      if (result.status === 'no_active_turn') setCancelling(false);
      await history.refresh();
    } catch (error) {
      if (sessionIdRef.current !== id || navigationEpoch.current !== epoch) return;
      setCancelling(false);
      onError(errorText(error));
    }
  }
  async function respond(response: InputResponse) {
    if (!state.canRespond) return;
    const id = sessionIdRef.current;
    await api(`/session/${id}/respond`, 'POST', { responses: [response] });
    if (sessionIdRef.current === id) await history.refresh();
  }
  return {
    ...state,
    sessionId: view.id,
    sessionIdRef,
    input,
    setInput,
    sending,
    snapshot: history.snapshot,
    historyError: history.error,
    sync: history.refresh,
    resetHistory,
    select,
    newSession,
    send,
    cancel,
    respond,
  };
}
