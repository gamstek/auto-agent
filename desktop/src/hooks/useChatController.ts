import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendCapabilities, InputResponse } from '@auto-agent/desktop-protocol';
import { api, errorText, sendErrorText, type Session } from '../bridge';
import { chatTrace } from '../lib/chat-debug';
import { chatPresentation } from '../lib/chat-presentation';
import { SessionDrafts } from '../lib/session-drafts';
import { useChat } from './useChat';
import { useApprovalPolicy } from './useApprovalPolicy';

type SelectedView = { id: string; origin: 'history' | 'first-submission' };

/** Frontend selection, commands and transient feedback. Corax still owns all run state. */
export function useChatController({
  connected,
  capabilities,
  refreshSessions,
  prepareSessionTitle,
  generateSessionTitle,
  clearSessionTitles,
  onError,
  onNavigate,
  onSend,
}: {
  connected: boolean;
  capabilities: BackendCapabilities;
  refreshSessions: () => Promise<Session[]>;
  prepareSessionTitle: (id: string) => void;
  generateSessionTitle: (id: string, content: string) => Promise<void>;
  clearSessionTitles: () => void;
  onError: (message: string) => void;
  onNavigate: (fresh: boolean) => void;
  onSend: () => void;
}) {
  const [view, setView] = useState<SelectedView>({ id: '', origin: 'history' });
  const drafts = useRef(new SessionDrafts());
  const [, renderDraft] = useState(0);
  const input = drafts.current.read(view.id);
  const setInput = useCallback(
    (text: string) => {
      drafts.current.set(view.id, text);
      renderDraft((value) => value + 1);
    },
    [view.id],
  );
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const sessionIdRef = useRef('');
  const navigationEpoch = useRef(0);
  const requestLock = useRef(false);
  const history = useChat(view.id, connected);
  const approval = useApprovalPolicy(connected);
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
      if (sessionIdRef.current !== id) navigationEpoch.current++;
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
    onError('');
    localStorage.removeItem('last-session');
    onNavigate(true);
  }, [onError, onNavigate]);
  const resetHistory = useCallback(() => {
    clearSessionTitles();
    history.clearHistory();
    approval.invalidate();
    settleFirstSubmission();
  }, [history.clearHistory, settleFirstSubmission, approval.invalidate, clearSessionTitles]);

  async function send(text = input) {
    if (
      sessionIdRef.current !== view.id ||
      !text.trim() ||
      requestLock.current ||
      !state.canSubmit ||
      !approval.ready
    )
      return;
    const source = view.id;
    const submitted = drafts.current.capture(source);
    requestLock.current = true;
    setSending(true);
    onError('');
    onSend();
    const epoch = navigationEpoch.current;
    const trace = chatTrace('send', { initial: !sessionIdRef.current });
    let dispatched = false;
    try {
      let id = source;
      if (!id) {
        trace.mark('create');
        const session = await api<Session>('/session', 'POST', {});
        trace.mark('created');
        id = session.id;
        prepareSessionTitle(id);
        if (navigationEpoch.current === epoch) {
          // Edits made while create() was pending still belong to this conversation.
          drafts.current.attach(id);
          sessionIdRef.current = id;
          setView({ id, origin: 'first-submission' });
          localStorage.setItem('last-session', id);
        } else if (submitted?.text.trim() === text.trim()) {
          // Preserve the original submission on its new ID, not on another selected view.
          drafts.current.attach(id, submitted);
          renderDraft((value) => value + 1);
        }
      }
      trace.mark('submit');
      dispatched = true;
      await api(`/session/${id}/prompt_async`, 'POST', { content: text.trim() });
      trace.mark('accepted');
      void generateSessionTitle(id, text);
      setSending(false);
      if (drafts.current.accepted(id, submitted, text)) renderDraft((value) => value + 1);
      if (navigationEpoch.current === epoch) {
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
        onError(dispatched ? sendErrorText(error) : errorText(error));
        await history.refresh().catch(() => {});
      }
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
  const respond = useCallback(
    async (response: InputResponse) => {
      if (!state.canRespond)
        throw { message: '会话状态尚未确认，本次响应未提交。', admission: 'rejected' };
      const id = sessionIdRef.current;
      await api(`/session/${id}/respond`, 'POST', { responses: [response] });
      if (sessionIdRef.current === id) await history.refresh();
    },
    [state.canRespond, history.refresh],
  );
  return {
    ...state,
    composerConnected: state.composerConnected && approval.ready,
    approval,
    sessionId: view.id,
    sessionIdRef,
    input,
    draftIdentity: navigationEpoch.current,
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
