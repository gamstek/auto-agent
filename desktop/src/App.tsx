import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { History, MessageSquarePlus, RefreshCw, X } from 'lucide-react';
import type { BackendCapabilities } from '@auto-agent/desktop-protocol';
import { desktop, errorText, native } from './bridge';
import { Settings, SettingsNavigation } from './components/Settings/Settings';
import { Titlebar } from './components/Titlebar/Titlebar';
import { Composer } from './components/Composer/Composer';
import { Button } from './components/Button/Button';
import { IconButton } from './components/IconButton/IconButton';
import { SessionList } from './components/SessionList/SessionList';
import { SearchField } from './components/SearchField/SearchField';
import { Welcome } from './components/Welcome/Welcome';
import { MessageList } from './components/MessageList/MessageList';
import { Instruments } from './components/Instruments/Instruments';
import { NavigationRail } from './components/NavigationRail/NavigationRail';
import { ChatMessage } from './components/ChatMessage/ChatMessage';
import { ChatInputRequest } from './components/ChatInputRequest/ChatInputRequest';
import { StartupScreen } from './components/StartupScreen/StartupScreen';
import { ProcessingLabel } from './components/ProcessingLabel/ProcessingLabel';
import { useSessions } from './hooks/useSessions';
import { useChatController } from './hooks/useChatController';
import { useBackendLifecycle, type BackendConnectionState } from './hooks/useBackendLifecycle';
import { useQuestionSuggestions } from './hooks/useQuestionSuggestions';
import './App.css';

export function App() {
  const [sidebar, setSidebar] = useState(true),
    [page, setPage] = useState<'chat' | 'settings' | 'instruments'>('chat');
  const settings = page === 'settings';
  const setSettings = (value: boolean) => setPage(value ? 'settings' : 'chat');
  const [sessionFilter, setSessionFilter] = useState('');
  const [settingsTab, setSettingsTab] = useState('model');
  const [capabilities, setCapabilities] = useState<BackendCapabilities>({});
  const [connection, setConnection] = useState<BackendConnectionState>('starting');
  const [error, setError] = useState('');
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
          { transform: `translateX(${before.left - after.left}px)`, width: `${before.width}px` },
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
  const [showBottom, setShowBottom] = useState(false);
  const [visibleCount, setVisibleCount] = useState(50);
  const scroll = useRef<HTMLDivElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    stick = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resetViewport = useCallback((fresh: boolean) => {
    setVisibleCount(50);
    stick.current = true;
    if (fresh) inputRef.current?.focus();
  }, []);
  const beforeSend = useCallback(() => {
    stick.current = true;
  }, []);
  const {
    sessionId,
    sessionIdRef,
    input,
    setInput,
    sending,
    snapshot,
    messages,
    inputs,
    busy,
    streamPaused,
    composerConnected,
    canCancel,
    canRespond,
    hasConversation,
    activity,
    historyError: chatError,
    select,
    newSession,
    send,
    cancel,
    respond,
    sync,
    resetHistory,
  } = useChatController({
    connected: connection === 'connected',
    capabilities,
    refreshSessions,
    onError: setError,
    onNavigate: resetViewport,
    onSend: beforeSend,
  });
  const {
    initialized,
    identity: recommendationIdentity,
    booting,
    bootStage,
    boot,
    settingsSaved,
  } = useBackendLifecycle({
    currentSessionId: sessionIdRef,
    selectSession: select,
    syncSession: sync,
    resetHistory,
    refreshSessions,
    onConnectionChange: setConnection,
    onCapabilities: setCapabilities,
    onError: setError,
  });
  const recommendations = useQuestionSuggestions(
    page === 'chat' && !hasConversation,
    connection === 'connected',
    sessions,
    recommendationIdentity,
  );
  const older = messages.length > visibleCount;
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!initialized || event.isComposing || event.repeat) return;
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
  }, [settings, sidebar, initialized, newSession]);
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ behavior: 'instant' });
  }, [snapshot?.revision, settings]);

  const composer = (
    <Composer
      input={input}
      onInput={setInput}
      inputRef={inputRef}
      onSend={() => void send()}
      onCancel={() => void cancel()}
      busy={busy}
      sending={sending}
      canCancel={canCancel}
      connected={composerConnected}
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
          void native('hide_main').catch((error) => setError(errorText(error)));
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
            onSaved={settingsSaved}
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
                {activity && (
                  <div className="chat-activity" role="status">
                    <ProcessingLabel active={activity.active} text={activity.text} />
                  </div>
                )}
                {inputs.map((entry) => (
                  <ChatInputRequest
                    key={`${sessionId}:${entry.request.requestId}`}
                    input={entry}
                    disabled={!canRespond}
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
