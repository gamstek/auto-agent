import type { BackendCapabilities, ChatSnapshot } from '@auto-agent/desktop-protocol';

/** Derive UI affordances from the confirmed native projection, never cached display alone. */
export function chatPresentation({
  sessionId,
  snapshot,
  ready,
  loading,
  historyError,
  connected,
  capabilities,
  sending,
  cancelling,
  firstSubmission,
}: {
  sessionId: string;
  snapshot: ChatSnapshot | null;
  ready: boolean;
  loading: boolean;
  historyError: string;
  connected: boolean;
  capabilities: BackendCapabilities;
  sending: boolean;
  cancelling: boolean;
  firstSubmission: boolean;
}) {
  const messages = snapshot?.conversation.messages ?? [];
  const busy = ready && !!snapshot?.turnActive;
  const backgroundBusy = ready && !!snapshot?.busy && !busy;
  const streamPaused = !ready || !connected || !!snapshot?.connectionError || !!historyError;
  const inputs = snapshot?.closed
    ? []
    : Object.values(snapshot?.conversation.inputs ?? {}).filter((input) => input.status === 'open');
  const sessionReady =
    connected &&
    (!sessionId || ready) &&
    !loading &&
    !historyError &&
    !snapshot?.connectionError &&
    !snapshot?.closed;
  const composerConnected = !!sessionReady && capabilities.sessions?.send === true;
  let activity: { text: string; active: boolean } | undefined;
  if (loading) {
    if (!snapshot && !firstSubmission) activity = { text: '正在读取会话…', active: false };
  } else if (cancelling || backgroundBusy || (busy && (snapshot?.waiting || streamPaused))) {
    activity = {
      text: cancelling
        ? '正在取消，等待后端确认…'
        : streamPaused
          ? '等待恢复事件连接…'
          : snapshot?.waiting
            ? '等待输入或任务完成'
            : '后台任务执行中，可继续对话',
      active: busy && !streamPaused && !snapshot?.waiting,
    };
  }
  return {
    messages,
    inputs,
    busy,
    backgroundBusy,
    streamPaused,
    composerConnected,
    activity,
    canSubmit: composerConnected && !busy && inputs.length === 0,
    canCancel: connected && ready && capabilities.sessions?.cancel === true && !cancelling,
    canRespond:
      connected &&
      ready &&
      !snapshot?.closed &&
      !historyError &&
      !snapshot?.connectionError &&
      capabilities.interaction?.respond === true,
    hasConversation: !!sessionId || messages.length > 0 || sending,
  };
}
