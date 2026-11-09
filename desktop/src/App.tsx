import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { History, MessageSquarePlus, RefreshCw, X } from 'lucide-react';
import type { BackendCapabilities, InputResponse } from '@auto-agent/desktop-protocol';
import {
  api,
  type BackendHealth,
  assertDesktopProtocol,
  desktop,
  errorText,
  sendErrorText,
  native,
  type ServiceEvent,
  isAgentEvent,
  type Session,
} from './bridge';
import { Settings, SettingsNavigation } from './components/Settings/Settings';
import { Titlebar } from './components/Titlebar/Titlebar';
import { Composer } from './components/Composer/Composer';
import { Button } from './components/Button/Button';
import { IconButton } from './components/IconButton/IconButton';
import { SessionList } from './components/SessionList/SessionList';
import { useSessions } from './hooks/useSessions';
import { SearchField } from './components/SearchField/SearchField';
import { Welcome } from './components/Welcome/Welcome';
import { MessageList } from './components/MessageList/MessageList';
import { Instruments } from './components/Instruments/Instruments';
import { NavigationRail } from './components/NavigationRail/NavigationRail';
import { ChatMessage } from './components/ChatMessage/ChatMessage';
import { ChatInputRequest } from './components/ChatInputRequest/ChatInputRequest';
import { useChat } from './hooks/useChat';
import { useQuestionSuggestions } from './hooks/useQuestionSuggestions';
import { StartupScreen } from './components/StartupScreen/StartupScreen';
import { ProcessingLabel } from './components/ProcessingLabel/ProcessingLabel';
import { chatTrace } from './lib/chat-debug';
import './App.css';

export function App() {
  const [sidebar, setSidebar] = useState(true),
    [page, setPage] = useState<'chat' | 'settings' | 'instruments'>('chat');
  const settings = page === 'settings';
  const setSettings = (value: boolean) => setPage(value ? 'settings' : 'chat');
  const [sessionFilter, setSessionFilter] = useState('');
  const [settingsTab, setSettingsTab] = useState('model');
  const [capabilities, setCapabilities] = useState<BackendCapabilities>({});
  const [maximized, setMaximized] = useState(false),
    [instant, setInstant] = useState(false);
  const mainRef = useRef<HTMLElement>(null),
    viewRef = useRef<HTMLDivElement>(null);
  const previousRect = useRef<DOMRect | null>(null),
    layoutAnimation = useRef<Animation | null>(null),
    pageAnimation = useRef<Animation | null>(null);
  const lastPage = useRef(page);
  function motionIntent(animate: boolean) {
    const immediate = !animate || matchMedia('(prefers-reduced-motion: reduce)').matches;
    setInstant(immediate);
    return !immediate;
  }
  function toggleSidebar(animate = true) {
    previousRect.current = motionIntent(animate)
      ? (mainRef.current?.getBoundingClientRect() ?? null)
      : null;
    setSidebar((value) => !value);
  }
  function showChat(animate = true) {
    motionIntent(animate);
    setSettings(false);
    return true;
  }
  function showSettings(tab: string, animate = true) {
    motionIntent(animate);
    setSettingsTab(tab);
    setSettings(true);
    if (!sidebar) toggleSidebar(animate);
  }
  useLayoutEffect(() => {
    layoutAnimation.current?.cancel();
    const before = previousRect.current,
      element = mainRef.current;
    previousRect.current = null;
    if (before && element && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const after = element.getBoundingClientRect();
      layoutAnimation.current = element.animate(
        [
          {
            transform: `translateX(${before.left - after.left}px)`,
            width: `${before.width}px`,
          },
          { transform: 'translateX(0)', width: `${after.width}px` },
        ],
        { duration: 220, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
      );
    }
    return () => layoutAnimation.current?.cancel();
  }, [sidebar]);
  useLayoutEffect(() => {
    pageAnimation.current?.cancel();
    if (
      lastPage.current !== page &&
      !instant &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      pageAnimation.current =
        viewRef.current?.animate(
          [
            { opacity: 0.65, transform: 'translateY(4px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
        ) ?? null;
    lastPage.current = page;
    return () => pageAnimation.current?.cancel();
  }, [page]);
  const {
    sessions,
    loading: sessionsLoading,
    hasMore: moreSessions,
    error: sessionsError,
    refreshSessions,
    loadMore: loadMoreSessions,
  } = useSessions();
  const [sessionId, setSessionId] = useState('');
  const [input, setInput] = useState('');
  const [connection, setConnection] = useState<'starting' | 'connected' | 'disconnected'>(
    'starting',
  );
  const [initialized, setInitialized] = useState(false);
  const [recommendationIdentity, setRecommendationIdentity] = useState(0);
  const [booting, setBooting] = useState(true);
  const [bootStage, setBootStage] = useState<'server' | 'workspace'>('server');
  const bootLock = useRef(false);
  const [error, setError] = useState(''),
    [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showBottom, setShowBottom] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const {
    snapshot,
    loading: chatLoading,
    error: chatError,
    refresh: sync,
    ready: chatReady,
    clearHistory,
  } = useChat(sessionId, connection === 'connected');
  const messages = snapshot?.conversation.messages ?? [];
  const busy = chatReady && !!snapshot?.turnActive;
  const backgroundBusy = chatReady && !!snapshot?.busy && !busy;
  const hasActiveAssistant = messages.some(
    (message) =>
      message.role === 'assistant' &&
      message.metadata?.turnId &&
      snapshot?.conversation.turns[message.metadata.turnId]?.status === 'active',
  );
  const streamPaused =
    !chatReady || connection !== 'connected' || !!snapshot?.connectionError || !!chatError;
  const inputs = snapshot?.closed
    ? []
    : Object.values(snapshot?.conversation.inputs ?? {}).filter((value) => value.status === 'open');
  const older = messages.length > visibleCount;
  const idRef = useRef(''),
    scroll = useRef<HTMLDivElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    stick = useRef(true);
  const requestLock = useRef(false),
    inputRef = useRef<HTMLTextAreaElement>(null);
  const navigationEpoch = useRef(0);
  useEffect(() => {
    chatTrace('chat-state').mark('state', {
      sending,
      loading: chatLoading,
      busy,
      connected: connection === 'connected',
    });
  }, [sending, chatLoading, busy, connection]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!initialized) return;
      if (event.isComposing || event.repeat) return;
      if (event.ctrlKey || event.metaKey) {
        if (event.key === ',') {
          event.preventDefault();
          showSettings('model', false);
        } else if (event.key.toLowerCase() === 'b') {
          event.preventDefault();
          toggleSidebar(false);
        } else if (event.key.toLowerCase() === 'n') {
          event.preventDefault();
          if (showChat(false)) newSession();
        }
      } else if (event.key === 'Escape' && settings) {
        event.preventDefault();
        showChat(false);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [settings, sidebar, initialized]);
  function select(id: string) {
    navigationEpoch.current++;
    setVisibleCount(50);
    setCancelling(false);
    idRef.current = id;
    setSessionId(id);
    setError('');
    stick.current = true;
    localStorage.setItem('last-session', id);
  }
  async function boot() {
    if (bootLock.current) return;
    bootLock.current = true;
    clearHistory();
    setRecommendationIdentity((value) => value + 1);
    setBooting(true);
    setBootStage('server');
    setConnection('starting');
    setError('');
    try {
      await native('backend_start');
      const health = await api<BackendHealth>('/global/health');
      assertDesktopProtocol(health);
      setCapabilities(health.capabilities ?? {});
      setBootStage('workspace');
      const list = await refreshSessions();
      const previous = localStorage.getItem('last-session');
      if (idRef.current) await sync();
      else if (previous && list.some((s) => s.id === previous)) select(previous);
      setConnection('connected');
      setInitialized(true);
    } catch (e) {
      setConnection('disconnected');
      setError(errorText(e));
    } finally {
      bootLock.current = false;
      setBooting(false);
    }
  }
  useEffect(() => {
    if (!desktop) {
      setBooting(false);
      setConnection('disconnected');
      setError('请运行 pnpm dev:desktop，通过桌面应用连接本地 Corax 服务。');
      return;
    }
    let disposed = false;
    const cleanup: (() => void)[] = [];
    void (async () => {
      const events = await listen<ServiceEvent>('agent-event', ({ payload: event }) => {
        if (!isAgentEvent(event)) return;
        if (event.type === 'session.updated') void refreshSessions().catch(() => {});
        if (event.sessionId !== idRef.current) return;
        if (event.type === 'session.error') {
          setError(String(event.properties.message ?? '请求失败'));
          void sync().catch(() => {});
        }
      });
      const streams = await listen<string>('backend-stream', ({ payload }) => {
        if (bootLock.current) return;
        setRecommendationIdentity((value) => value + 1);
        if (payload === 'connected') {
          clearHistory();
          void api<BackendHealth>('/global/health')
            .then((health) => {
              assertDesktopProtocol(health);
              setCapabilities(health.capabilities ?? {});
              setConnection('connected');
              void sync().catch(() => {});
              void refreshSessions().catch(() => {});
            })
            .catch((e) => {
              setConnection('disconnected');
              setError(errorText(e));
            });
        } else setConnection('disconnected');
      });
      if (disposed) {
        events();
        streams();
        return;
      }
      cleanup.push(events, streams);
      await boot();
    })().catch((e) => {
      if (!disposed) {
        setBooting(false);
        setConnection('disconnected');
        setError(errorText(e));
      }
    });
    return () => {
      disposed = true;
      cleanup.forEach((fn) => fn());
    };
  }, []);
  useEffect(() => {
    if (!busy) setCancelling(false);
  }, [busy]);
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ behavior: 'instant' });
  }, [snapshot?.revision, settings]);
  async function send(text = input) {
    if (
      !text.trim() ||
      requestLock.current ||
      busy ||
      (!!sessionId && !chatReady) ||
      chatLoading ||
      chatError ||
      snapshot?.connectionError ||
      connection !== 'connected' ||
      inputs.length ||
      snapshot?.closed ||
      capabilities.sessions?.send !== true
    )
      return;
    requestLock.current = true;
    setSending(true);
    setError('');
    stick.current = true;
    const epoch = navigationEpoch.current;
    const trace = chatTrace('send', { initial: !idRef.current });
    try {
      let id = idRef.current;
      if (!id) {
        trace.mark('create');
        const session = await api<Session>('/session', 'POST', {});
        trace.mark('created');
        id = session.id;
        if (navigationEpoch.current === epoch) {
          idRef.current = id;
          setSessionId(id);
          localStorage.setItem('last-session', id);
        }
      }
      trace.mark('submit');
      await api(`/session/${id}/prompt_async`, 'POST', { content: text.trim() });
      trace.mark('accepted');
      setSending(false);
      if (navigationEpoch.current === epoch) {
        setInput('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
        trace.mark('sync');
        await sync();
        trace.mark('synced');
      }
      trace.mark('list');
      void refreshSessions()
        .then(() => trace.mark('listed'))
        .catch(() => {});
    } catch (e) {
      trace.mark('error');
      if (navigationEpoch.current === epoch) setError(sendErrorText(e));
      await sync().catch(() => {});
    } finally {
      requestLock.current = false;
      setSending(false);
      trace.mark('end');
    }
  }
  function newSession() {
    navigationEpoch.current++;
    setVisibleCount(50);
    setCancelling(false);
    idRef.current = '';
    setSessionId('');
    setError('');
    setInput('');
    localStorage.removeItem('last-session');
    stick.current = true;
    inputRef.current?.focus();
  }
  async function respond(response: InputResponse) {
    if (!chatReady || snapshot?.closed || capabilities.interaction?.respond !== true) return;
    const id = sessionId;
    await api(`/session/${id}/respond`, 'POST', { responses: [response] });
    if (idRef.current === id) await sync();
  }
  const hasConversation = !!sessionId || messages.length > 0 || sending;
  const recommendations = useQuestionSuggestions(
    page === 'chat' && !hasConversation,
    connection === 'connected',
    sessions
      .slice(0, 3)
      .map(({ id, title, updatedAt }) => `${id}:${updatedAt}:${title}`)
      .join('|'),
    recommendationIdentity,
  );
  const composer = (
    <Composer
      input={input}
      onInput={setInput}
      inputRef={inputRef}
      onSend={() => void send()}
      onCancel={() => {
        if (!chatReady || cancelling || capabilities.sessions?.cancel !== true) return;
        const id = sessionId,
          epoch = navigationEpoch.current;
        setCancelling(true);
        void api<{ status: string }>(`/session/${id}/abort`, 'POST', {})
          .then(async (result) => {
            if (idRef.current !== id || navigationEpoch.current !== epoch) return;
            if (result.status === 'no_active_turn') setCancelling(false);
            await sync();
          })
          .catch((e) => {
            if (idRef.current !== id || navigationEpoch.current !== epoch) return;
            setCancelling(false);
            setError(errorText(e));
          });
      }}
      busy={busy}
      sending={sending}
      canCancel={
        chatReady &&
        capabilities.sessions?.cancel === true &&
        !cancelling &&
        connection === 'connected'
      }
      connected={
        connection === 'connected' &&
        (!sessionId || chatReady) &&
        !chatLoading &&
        !chatError &&
        !snapshot?.connectionError &&
        !snapshot?.closed &&
        capabilities.sessions?.send === true
      }
      waitingForInput={inputs.length > 0}
      showBottom={showBottom && hasConversation}
      onBottom={() => {
        stick.current = true;
        bottom.current?.scrollIntoView();
      }}
    />
  );
  // Only initial boot gates mounting the workspace; reconnects retain the user's current view and draft.
  if (!initialized)
    return (
      <StartupScreen
        busy={booting}
        stage={bootStage}
        error={error}
        canRetry={desktop}
        maximized={maximized}
        onRetry={() => void boot()}
        onError={setError}
        onWindowState={setMaximized}
      />
    );
  return (
    <div
      className={`app ${sidebar ? 'with-sidebar' : ''} ${maximized ? 'is-maximized' : ''} ${instant ? 'instant-motion' : ''}`}
      data-backend-state={connection}
    >
      <Titlebar
        sidebar={sidebar}
        onToggleSidebar={toggleSidebar}
        onError={setError}
        onWindowState={setMaximized}
      />
      <NavigationRail
        instrumentsAvailable={capabilities.devices?.list === true}
        page={page}
        onNavigate={(target, animate) => {
          if (target === 'settings') showSettings('model', animate);
          else if (target === 'chat') showChat(animate);
          else {
            motionIntent(animate);
            setPage(target);
          }
        }}
        onHide={() => {
          void native('hide_main').catch((e) => setError(errorText(e)));
        }}
      />
      <aside className="session-sidebar" aria-hidden={!sidebar} inert={!sidebar}>
        {settings ? (
          <SettingsNavigation
            selected={settingsTab}
            onSelect={(tab, animate) => {
              motionIntent(animate);
              setSettingsTab(tab);
            }}
            onBack={showChat}
          />
        ) : (
          <>
            <div className="workspace-heading">
              <span>量仔</span>
              <span className="workspace-badge">本地</span>
            </div>
            <Button
              variant="ghost"
              className="new-session"
              onClick={() => {
                newSession();
                setSettings(false);
              }}
            >
              <MessageSquarePlus size={19} />
              新对话
            </Button>
            <SearchField label="搜索会话" value={sessionFilter} onChange={setSessionFilter} />
            <h2>
              <History size={14} />
              最近会话
            </h2>
            <SessionList
              sessions={sessions}
              selectedId={sessionId}
              query={sessionFilter}
              active={sidebar && connection === 'connected'}
              loading={sessionsLoading}
              hasMore={moreSessions}
              error={sessionsError}
              onSelect={(id) => {
                select(id);
                setSettings(false);
              }}
              onLoadMore={loadMoreSessions}
              onRetry={() => {
                if (moreSessions) void loadMoreSessions();
                else void refreshSessions().catch(() => {});
              }}
            />
          </>
        )}
      </aside>
      <main
        ref={mainRef}
        className={`main-area ${!hasConversation && page === 'chat' ? 'is-empty' : ''} ${settings ? 'settings-view' : ''}`}
      >
        {page === 'chat' && (
          <div className="content-toolbar">
            <span className="content-caption">
              {settings
                ? '偏好设置'
                : hasConversation
                  ? (sessions
                      .find((session) => session.id === sessionId)
                      ?.title.replace('New session', '新对话') ?? '新对话')
                  : 'AI 助理'}
            </span>
            <div
              className="page-tabs"
              aria-label="页面切换"
              data-active={settings ? 'settings' : 'chat'}
            >
              <span className="page-tab-indicator" aria-hidden="true" />
              <button
                className={!settings ? 'selected' : ''}
                onClick={(event) => showChat(event.detail > 0)}
              >
                聊天
              </button>
              <button
                aria-label="打开设置页面"
                className={settings ? 'selected' : ''}
                onClick={(event) => showSettings('model', event.detail > 0)}
              >
                设置
              </button>
            </div>
            <div className="toolbar-actions">
              <IconButton
                className="toolbar-new"
                label="开启新对话"
                title="开启新对话"
                onClick={() => {
                  newSession();
                  setSettings(false);
                }}
              >
                <MessageSquarePlus size={18} />
              </IconButton>
            </div>
          </div>
        )}
        <div className="view-host" ref={viewRef}>
          <Settings
            initialTab={settingsTab}
            onSaved={(applied) => {
              if (applied) void boot();
              else {
                clearHistory();
                setRecommendationIdentity((value) => value + 1);
              }
            }}
            active={settings}
            instant={instant}
          />
          {page === 'instruments' && <Instruments onConfigure={() => showSettings('device')} />}
          {page === 'chat' && (
            <>
              {error && (
                <div className="chat-notice" role="alert">
                  <span>{error}</span>
                  <IconButton label="关闭提示" onClick={() => setError('')}>
                    <X size={16} />
                  </IconButton>
                </div>
              )}
              {connection !== 'connected' && (
                <div className="connection-banner">
                  <span>
                    {connection === 'starting'
                      ? '正在准备你的本地工作空间…'
                      : '连接中断。恢复连接后将读取已有任务状态，不会自动重发请求。'}
                  </span>
                  <Button
                    disabled={connection === 'starting' || !desktop}
                    onClick={() => void boot()}
                  >
                    <RefreshCw size={15} />
                    重新连接
                  </Button>
                </div>
              )}
              {(chatError || snapshot?.connectionError || snapshot?.error) && (
                <div className="chat-notice" role="alert">
                  <span>{chatError || snapshot?.connectionError || snapshot?.error}</span>
                  <Button variant="ghost" onClick={() => void sync()}>
                    刷新会话状态
                  </Button>
                </div>
              )}
              {snapshot?.closed && (
                <div className="chat-notice" role="status">
                  此会话已结束，历史记录仍可查看。
                  <Button
                    onClick={() => {
                      const draft = input;
                      newSession();
                      setInput(draft);
                    }}
                  >
                    新建会话
                  </Button>
                </div>
              )}
              <MessageList
                ref={scroll}
                onScroll={() => {
                  const element = scroll.current!;
                  stick.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 100;
                  setShowBottom(!stick.current);
                }}
              >
                {older && (
                  <Button
                    variant="ghost"
                    className="older-button"
                    onClick={() => {
                      const element = scroll.current;
                      const anchor = element?.querySelector<HTMLElement>('[data-message-id]');
                      const position = anchor?.getBoundingClientRect().top;
                      stick.current = false;
                      setVisibleCount((value) => value + 50);
                      requestAnimationFrame(() => {
                        if (element && anchor?.isConnected && position !== undefined)
                          element.scrollTop += anchor.getBoundingClientRect().top - position;
                      });
                    }}
                  >
                    加载更早的消息
                  </Button>
                )}
                {!hasConversation && (
                  <Welcome
                    composer={composer}
                    disabled={connection !== 'connected' || sending}
                    connected={connection === 'connected'}
                    suggestions={recommendations.suggestions}
                    loading={recommendations.loading}
                    onQuestion={(question) => void send(question)}
                  />
                )}
                {snapshot &&
                  messages
                    .slice(-visibleCount)
                    .map((message) => (
                      <ChatMessage
                        key={`${sessionId}:${message.id}`}
                        sessionId={sessionId}
                        message={message}
                        conversation={snapshot.conversation}
                        callStates={snapshot.calls}
                        details={
                          message.metadata?.turnId
                            ? snapshot.turnDetails[message.metadata.turnId]
                            : undefined
                        }
                        stopped={snapshot.closed}
                        paused={streamPaused}
                      />
                    ))}
                {(chatLoading
                  ? !snapshot
                  : sending ||
                    cancelling ||
                    backgroundBusy ||
                    (busy && (!hasActiveAssistant || snapshot?.waiting || streamPaused))) && (
                  <div className="chat-activity" role="status">
                    <ProcessingLabel
                      active={busy && !streamPaused && !snapshot?.waiting}
                      text={
                        chatLoading
                          ? '正在读取会话…'
                          : cancelling
                            ? '正在取消，等待后端确认…'
                            : streamPaused
                              ? '等待恢复事件连接…'
                              : snapshot?.waiting
                                ? '等待输入或任务完成'
                                : sending
                                  ? '正在提交…'
                                  : backgroundBusy
                                    ? '后台任务执行中，可继续对话'
                                    : '正在处理'
                      }
                    />
                  </div>
                )}
                {inputs.map((input) => (
                  <ChatInputRequest
                    key={`${sessionId}:${input.request.requestId}`}
                    input={input}
                    disabled={
                      !chatReady ||
                      connection !== 'connected' ||
                      !!chatError ||
                      !!snapshot?.connectionError ||
                      capabilities.interaction?.respond !== true
                    }
                    onRespond={respond}
                  />
                ))}
                {snapshot &&
                  !busy &&
                  Object.values(snapshot.conversation.turns).at(-1)?.status === 'cancelled' && (
                    <p role="status">本轮已取消。</p>
                  )}
                <div ref={bottom} />
              </MessageList>
              {hasConversation && composer}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
