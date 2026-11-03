import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  Check,
  History,
  LoaderCircle,
  MessageSquarePlus,
  RefreshCw,
  Settings2,
  ShieldAlert,
  X,
  Minimize2,
  Home,
  BookOpen,
} from 'lucide-react';
import {
  api,
  desktop,
  errorText,
  native,
  type AgentEvent,
  type Message,
  type Session,
  type SessionState,
} from './bridge';
import { Settings, SettingsNavigation } from './components/Settings/Settings';
import { Titlebar } from './components/Titlebar/Titlebar';
import { Composer } from './components/Composer/Composer';
import { Button } from './components/Button/Button';
import { IconButton } from './components/IconButton/IconButton';
import { SessionList } from './components/SessionList/SessionList';
import { useSessions } from './hooks/useSessions';
import { SearchField } from './components/SearchField/SearchField';
import { Textarea } from './components/Textarea/Textarea';
import { MarkdownAnswer } from './components/MarkdownAnswer/MarkdownAnswer';
import { Avatar } from './components/Avatar/Avatar';
import { ResponseActions } from './components/ResponseActions/ResponseActions';
import { Welcome } from './components/Welcome/Welcome';
import { Conversation } from './components/Conversation/Conversation';
import './App.css';

const welcome =
  '你好！我是量仔，你的 Climber 专属小助理。可以帮你查阅知识、准备测样方案和跟踪仪器任务。有什么可以帮到你的吗？';
type Live = {
  id: string;
  text: string;
  reasoning: string;
  steps: { id: string; name: string; detail: string; status: string }[];
};
const labels: Record<string, string> = {
  skill: '加载技能',
  read: '读取资料',
  wiki: '检索知识',
  execute_script: '执行脚本',
  web_fetch: '读取网页',
  web_search: '搜索网页',
};

export function App() {
  const [sidebar, setSidebar] = useState(true),
    [settings, setSettings] = useState(false);
  const [sessionFilter, setSessionFilter] = useState('');
  const [settingsTab, setSettingsTab] = useState('model');
  const [maximized, setMaximized] = useState(false),
    [instant, setInstant] = useState(false);
  const mainRef = useRef<HTMLElement>(null),
    viewRef = useRef<HTMLDivElement>(null);
  const previousRect = useRef<DOMRect | null>(null),
    layoutAnimation = useRef<Animation | null>(null),
    pageAnimation = useRef<Animation | null>(null);
  const lastPage = useRef(settings);
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
      lastPage.current !== settings &&
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
    lastPage.current = settings;
    return () => pageAnimation.current?.cancel();
  }, [settings]);
  const {
    sessions,
    loading: sessionsLoading,
    hasMore: moreSessions,
    error: sessionsError,
    refreshSessions,
    loadMore: loadMoreSessions,
  } = useSessions();
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]),
    [live, setLive] = useState<Live | null>(null);
  const [state, setState] = useState<SessionState | null>(null),
    [input, setInput] = useState('');
  const [connection, setConnection] = useState<'starting' | 'connected' | 'disconnected'>(
    'starting',
  );
  const [error, setError] = useState(''),
    [sending, setSending] = useState(false),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState('');
  const [showBottom, setShowBottom] = useState(false),
    [older, setOlder] = useState(false);
  const idRef = useRef(''),
    scroll = useRef<HTMLDivElement>(null),
    bottom = useRef<HTMLDivElement>(null),
    stick = useRef(true);
  const requestLock = useRef(false),
    inputRef = useRef<HTMLTextAreaElement>(null);
  const olderExhausted = useRef(false);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
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
  }, [settings, sidebar]);
  const sync = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    const [history, status] = await Promise.all([
      api<Message[]>(`/session/${id}/message?limit=100`),
      api<SessionState>(`/session/${id}/state`),
    ]);
    if (id !== idRef.current) return;
    setMessages((previous) => {
      const combined = new Map(
        previous
          .filter((message) => message.sessionId === id)
          .map((message) => [message.id, message]),
      );
      for (const message of history) combined.set(message.id, message);
      return [...combined.values()].sort((a, b) => a.createdAt - b.createdAt);
    });
    setState(status);
    setBusy(status.running);
    setOlder(!olderExhausted.current && history.length === 100);
    if (!status.running) setLive(null);
  }, []);
  function select(id: string) {
    olderExhausted.current = false;
    idRef.current = id;
    setSessionId(id);
    setLive(null);
    setMessages([]);
    setState(null);
    setBusy(false);
    setError('');
    stick.current = true;
    localStorage.setItem('last-session', id);
    void sync().catch((e) => setError(errorText(e)));
  }
  async function boot() {
    setConnection('starting');
    setError('');
    try {
      await native('backend_start');
      setConnection('connected');
      const list = await refreshSessions();
      const previous = localStorage.getItem('last-session');
      if (idRef.current) await sync();
      else if (previous && list.some((s) => s.id === previous)) select(previous);
    } catch (e) {
      setConnection('disconnected');
      setError(errorText(e));
    }
  }
  useEffect(() => {
    if (!desktop) {
      setConnection('disconnected');
      setError('浏览器中仅预览界面。请运行 bun run desktop:dev 启动完整桌面应用。');
      return;
    }
    let disposed = false;
    const cleanup: (() => void)[] = [];
    void (async () => {
      const events = await listen<AgentEvent>('agent-event', ({ payload: event }) => {
        if (event.type === 'session.updated') void refreshSessions().catch(() => {});
        if (event.sessionId !== idRef.current) return;
        const p = event.properties;
        if (event.type === 'session.status') {
          setBusy(p.status === 'busy');
          if (p.status === 'idle') {
            void sync().catch((e) => setError(errorText(e)));
            void refreshSessions().catch(() => {});
          }
        }
        if (event.type === 'message.part.delta' || event.type === 'message.reasoning.delta') {
          setLive((old) => {
            const value =
              old?.id === event.messageId
                ? old
                : { id: event.messageId, text: '', reasoning: '', steps: [] };
            return {
              ...value,
              [event.type === 'message.part.delta' ? 'text' : 'reasoning']:
                (event.type === 'message.part.delta' ? value.text : value.reasoning) +
                String(p.delta ?? ''),
            };
          });
        }
        if (['tool.started', 'tool.completed', 'tool.failed', 'tool.skipped'].includes(event.type))
          setLive((old) => {
            const value =
              old?.id === event.messageId
                ? old
                : { id: event.messageId, text: '', reasoning: '', steps: [] };
            const step = {
              id: String(p.toolCallId),
              name: labels[String(p.name)] ?? String(p.name),
              detail: String(p.path ?? p.skill ?? p.message ?? ''),
              status: String(p.status),
            };
            const previous = value.steps.find((s) => s.id === step.id);
            return {
              ...value,
              steps: [
                ...value.steps.filter((s) => s.id !== step.id),
                { ...step, detail: step.detail || previous?.detail || '' },
              ].slice(-30),
            };
          });
        if (event.type === 'message.completed') {
          void sync().catch((e) => setError(errorText(e)));
          void refreshSessions().catch(() => {});
        }
        if (event.type === 'session.error') {
          setError(String(p.message ?? '请求失败'));
          void sync().catch(() => {});
        }
      });
      const streams = await listen<string>('backend-stream', ({ payload }) => {
        setConnection(payload === 'connected' ? 'connected' : 'disconnected');
        if (payload === 'connected') {
          void sync().catch(() => {});
          void refreshSessions().catch(() => {});
        }
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
    if (!desktop || connection !== 'connected') return;
    const timer = setInterval(() => void sync().catch(() => setConnection('disconnected')), 4000);
    return () => clearInterval(timer);
  }, [connection, sync]);
  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ behavior: 'instant' });
  }, [messages, live, settings]);
  async function send(text = input) {
    if (!text.trim() || requestLock.current || busy || connection !== 'connected' || state?.pending)
      return;
    requestLock.current = true;
    setSending(true);
    setError('');
    stick.current = true;
    try {
      let id = idRef.current;
      if (!id) {
        const session = await api<Session>('/session', 'POST', {});
        id = session.id;
        idRef.current = id;
        setSessionId(id);
        localStorage.setItem('last-session', id);
      }
      await api(`/session/${id}/prompt_async`, 'POST', { content: text.trim() });
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
      setBusy(true);
      await sync();
      await refreshSessions();
    } catch (e) {
      setError(`${errorText(e)}。请先刷新会话状态确认是否已受理。`);
      await sync().catch(() => {});
    } finally {
      requestLock.current = false;
      setSending(false);
    }
  }
  function newSession() {
    olderExhausted.current = false;
    idRef.current = '';
    setSessionId('');
    setMessages([]);
    setLive(null);
    setState(null);
    setBusy(false);
    setError('');
    setInput('');
    localStorage.removeItem('last-session');
    stick.current = true;
    inputRef.current?.focus();
  }
  async function resolveReview() {
    if (!state?.pending || !note.trim() || !sessionId) return;
    try {
      await api(`/session/${sessionId}/resolve_review`, 'POST', { runId: state.pending.id, note });
      setNote('');
      await sync();
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function loadOlder() {
    const id = sessionId;
    try {
      const page = await api<Message[]>(
        `/session/${id}/message?limit=100&offset=${messages.length}`,
      );
      if (id !== idRef.current) return;
      stick.current = false;
      setMessages((old) => [...page, ...old]);
      olderExhausted.current = page.length < 100;
      setOlder(!olderExhausted.current);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const hasConversation = messages.length > 0 || busy || !!state?.pending;
  const composer = (
    <Composer
      input={input}
      onInput={setInput}
      inputRef={inputRef}
      onSend={() => void send()}
      onCancel={() => {
        void api(`/session/${sessionId}/abort`, 'POST', {})
          .then(sync)
          .catch((e) => setError(errorText(e)));
      }}
      busy={busy}
      sending={sending}
      connected={connection === 'connected'}
      pendingReview={!!state?.pending}
      showBottom={showBottom && hasConversation}
      onBottom={() => {
        stick.current = true;
        bottom.current?.scrollIntoView();
      }}
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
      <nav className="navigation-rail" aria-label="主导航">
        <IconButton
          variant="rail"
          selected={!settings}
          label="聊天主页"
          title="聊天"
          onClick={(event) => showChat(event.detail > 0)}
        >
          <Home size={20} />
        </IconButton>
        <IconButton
          variant="rail"
          label="新建对话"
          title="新建对话"
          onClick={(event) => {
            if (showChat(event.detail > 0)) newSession();
          }}
        >
          <MessageSquarePlus size={20} />
        </IconButton>
        <IconButton
          variant="rail"
          label="历史会话"
          title="历史会话"
          onClick={(event) => toggleSidebar(event.detail > 0)}
        >
          <History size={20} />
        </IconButton>
        <IconButton
          variant="rail"
          selected={settings && settingsTab === 'resources'}
          label="知识与技能设置"
          title="知识与技能"
          onClick={(event) => showSettings('resources', event.detail > 0)}
        >
          <BookOpen size={20} />
        </IconButton>
        <span className="rail-divider" />
        <IconButton
          variant="rail"
          label="收起至悬浮助手"
          title="悬浮助手"
          onClick={() => native('hide_main').catch((e) => setError(errorText(e)))}
        >
          <Minimize2 size={19} />
        </IconButton>
        <div className="rail-spacer" />
        <IconButton
          variant="rail"
          selected={settings}
          label="设置"
          title="设置"
          onClick={(event) => showSettings('model', event.detail > 0)}
        >
          <Settings2 size={20} />
        </IconButton>
      </nav>
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
        className={`main-area ${!hasConversation && !settings ? 'is-empty' : ''} ${settings ? 'settings-view' : ''}`}
      >
        {!settings && (
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
        )}
        <div className="view-host" ref={viewRef}>
          <Settings
            initialTab={settingsTab}
            onSaved={(applied) => {
              if (applied) void boot();
            }}
            active={settings}
            instant={instant}
          />
          {!settings && (
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
              <Conversation
                ref={scroll}
                onScroll={() => {
                  const element = scroll.current!;
                  stick.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight < 100;
                  setShowBottom(!stick.current);
                }}
              >
                {older && (
                  <Button variant="ghost" className="older-button" onClick={() => void loadOlder()}>
                    加载更早的消息
                  </Button>
                )}
                {hasConversation && (
                  <div className="message assistant welcome">
                    <Avatar />
                    <div className="bubble">{welcome}</div>
                  </div>
                )}
                {!hasConversation && (
                  <Welcome
                    composer={composer}
                    disabled={connection !== 'connected' || sending}
                    onQuestion={(question) => void send(question)}
                  />
                )}
                {messages.map((message) => (
                  <div className={`message ${message.role}`} key={message.id}>
                    {message.role === 'assistant' && <Avatar />}
                    <div className="bubble">
                      {message.role === 'assistant' ? (
                        <>
                          <MarkdownAnswer text={message.content} />
                          <ResponseActions message={message} />
                        </>
                      ) : (
                        <div className="user-text">{message.content}</div>
                      )}
                    </div>
                  </div>
                ))}
                {busy && (
                  <div className="message assistant">
                    <Avatar />
                    <div className="bubble live-bubble">
                      {live?.reasoning && (
                        <details className="thinking">
                          <summary>思考过程</summary>
                          <p>{live.reasoning}</p>
                        </details>
                      )}
                      {!!live?.steps.length && (
                        <details className="tool-steps" open={!live.text}>
                          <summary>处理过程 · {live.steps.length} 项</summary>
                          {live.steps.map((step) => (
                            <div key={step.id}>
                              <span>
                                {step.status === 'running' ? (
                                  <LoaderCircle size={13} className="spin" />
                                ) : step.status === 'completed' ? (
                                  <Check size={13} />
                                ) : (
                                  <ShieldAlert size={13} />
                                )}
                              </span>
                              <strong>{step.name}</strong>
                              <small>{step.detail || step.status}</small>
                            </div>
                          ))}
                        </details>
                      )}
                      {live?.text ? (
                        <MarkdownAnswer text={live.text} />
                      ) : (
                        <div className="working">
                          <LoaderCircle className="spin" size={16} />
                          量仔正在处理你的请求…
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {state?.pending && (
                  <section className="review-card">
                    <h2>
                      <ShieldAlert size={20} />
                      执行结果需要核对
                    </h2>
                    <p>
                      本次操作的外部效果尚未确认。请核对厂家当前任务与批次，再记录处理结果；不会自动重放旧请求。
                    </p>
                    {state.pending.executions
                      .filter((e) => e.status === 'unknown')
                      .map((e) => (
                        <div className="review-detail" key={e.id}>
                          <code>{e.diagnostic?.code ?? 'OUTCOME_UNKNOWN'}</code>
                          <p>{e.diagnostic?.message ?? '原执行未保留详细诊断，请查看日志。'}</p>
                          {e.diagnostic?.batchId && <span>批次：{e.diagnostic.batchId}</span>}
                        </div>
                      ))}
                    <label className="field">
                      <span>操作者核对说明</span>
                      <Textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="记录已核对的批次、状态和处理结论"
                      />
                    </label>
                    <Button
                      variant="primary"
                      disabled={!note.trim()}
                      onClick={() => void resolveReview()}
                    >
                      记录核对结果
                    </Button>
                  </section>
                )}
                <div ref={bottom} />
              </Conversation>
              {hasConversation && composer}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
