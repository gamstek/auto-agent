import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  FileText,
  FolderOpen,
  GitFork,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import type {
  KnowledgeOperationState,
  KnowledgePage,
  KnowledgePageEntry,
  KnowledgeSnapshot,
} from '@auto-agent/desktop-protocol';
import type { Settings } from '../../bridge';
import { knowledgeKind, knowledgeKinds } from '../../lib/knowledge-graph';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { SearchField } from '../SearchField/SearchField';
import { KnowledgeSources } from '../KnowledgeSources/KnowledgeSources';
import { KnowledgeGraph } from '../KnowledgeGraph/KnowledgeGraph';
import { KnowledgeReader } from '../KnowledgeReader/KnowledgeReader';
import './KnowledgeWorkspace.css';

const views = [
  { id: 'graph', label: '图谱', icon: GitFork },
  { id: 'catalog', label: '目录', icon: BookOpen },
  { id: 'files', label: '资料', icon: FolderOpen },
] as const;
type View = (typeof views)[number]['id'];

export function KnowledgeWorkspace({
  sources,
  snapshot,
  operationState,
  blockedReason,
  revisionMismatch,
  blocked,
  busy,
  loading,
  submitting,
  error,
  pages,
  nextOffset,
  paging,
  page,
  reading,
  readError,
  resetKey,
  onAdd,
  onRemove,
  onRefresh,
  onStart,
  onCancel,
  onRead,
  onClosePage,
  onMore,
}: {
  sources: Settings['llmWiki']['sources'];
  snapshot?: KnowledgeSnapshot;
  operationState?: KnowledgeOperationState;
  blockedReason?: string;
  revisionMismatch: boolean;
  blocked: boolean;
  busy: boolean;
  loading: boolean;
  submitting: boolean;
  error: string;
  pages: KnowledgePageEntry[];
  nextOffset: number | null;
  paging: boolean;
  page?: KnowledgePage;
  reading: boolean;
  readError: string;
  resetKey: number;
  onAdd: (kind: 'file' | 'directory') => void;
  onRemove: (id: string) => void;
  onRefresh: () => void;
  onStart: (id?: string) => void;
  onCancel: () => void;
  onRead: (entry: KnowledgePageEntry | KnowledgePage, offset?: number) => void;
  onClosePage: () => void;
  onMore: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLElement>(null);
  const right = useRef<HTMLElement>(null);
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const tabId = useId();
  const [view, setView] = useState<View>('graph');
  const [instant, setInstant] = useState(true);
  const [compact, setCompact] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [selected, setSelected] = useState<KnowledgePageEntry>();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [graphOnly, setGraphOnly] = useState(false);
  const previousReading = useRef(false);
  const operation = operationState?.operation;
  useLayoutEffect(() => {
    const measure = () => {
      const width = root.current!.clientWidth;
      if (width) setCompact(width < 760);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root.current!);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setReaderOpen(false);
    setSelected(undefined);
  }, [resetKey]);
  useEffect(() => {
    if (!readerOpen) onClosePage();
  }, [readerOpen]);
  useLayoutEffect(() => {
    if (compact && readerOpen) right.current?.focus({ preventScroll: true });
    else if (previousReading.current && !readerOpen) left.current?.focus({ preventScroll: true });
    previousReading.current = compact && readerOpen;
  }, [compact, readerOpen, selected?.path]);
  const filtered = useMemo(
    () =>
      pages.filter(
        (entry) =>
          (kind === 'all' || entry.type === kind) &&
          `${entry.title} ${entry.summary} ${entry.path}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
      ),
    [pages, kind, query],
  );
  const related = selected
    ? [...new Set(selected.related ?? [])].flatMap((path) => {
        const target = path.split('|')[0]!.split('#')[0]!;
        const entry = pages.find(
          (page) => page.path === (target.endsWith('.md') ? target : `${target}.md`),
        );
        return entry ? [entry] : [];
      })
    : [];
  function changeView(next: View, animate = false) {
    if (next === view) return;
    setInstant(!animate || matchMedia('(prefers-reduced-motion: reduce)').matches);
    setView(next);
    if (next !== 'graph') setGraphOnly(false);
    if (compact) setReaderOpen(false);
  }
  function select(entry: KnowledgePageEntry) {
    setSelected(entry);
    setReaderOpen(true);
    setGraphOnly(false);
    onRead(entry);
  }
  return (
    <div
      className="knowledge-base"
      ref={root}
      data-view={view}
      data-animate={!instant}
      data-compact={compact}
      data-reading={readerOpen}
      data-graph-only={graphOnly}
    >
      {blockedReason && (
        <p className="knowledge-notice" role="status">
          {blockedReason}
        </p>
      )}
      {revisionMismatch && !blockedReason && (
        <p className="knowledge-notice" role="status">
          资料配置尚未在当前后端生效。外部修改配置后，请重启应用再刷新状态。
        </p>
      )}
      {operationState?.admissionUncertain && (
        <p className="knowledge-notice" role="alert">
          整理请求结果尚未确认，未自动重试。请刷新并核对已发布内容。
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="knowledge-layout">
        <section className="knowledge-main" aria-label="知识浏览区" ref={left} tabIndex={-1}>
          <header className="knowledge-view-heading">
            <div className="knowledge-workspace-title">
              <BookOpen size={18} />
              <h1>知识库</h1>
            </div>
            <div
              className="knowledge-view-tabs"
              data-instant={instant}
              role="tablist"
              aria-label="知识库视图"
              onKeyDown={(event) => {
                const index = views.findIndex((entry) => entry.id === view);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % views.length
                    : event.key === 'ArrowLeft'
                      ? (index + views.length - 1) % views.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? views.length - 1
                          : undefined;
                if (next !== undefined) {
                  event.preventDefault();
                  changeView(views[next]!.id);
                  tabButtons.current[next]?.focus();
                }
              }}
            >
              {views.map(({ id, label, icon: Icon }, index) => (
                <Button
                  key={id}
                  variant="ghost"
                  role="tab"
                  aria-label={label}
                  id={`${tabId}-${id}`}
                  aria-controls={`${tabId}-${id}-content`}
                  aria-selected={view === id}
                  tabIndex={view === id ? 0 : -1}
                  ref={(element) => {
                    tabButtons.current[index] = element;
                  }}
                  onClick={(event) => changeView(id, event.detail > 0)}
                >
                  <Icon size={13} />
                  {label}
                  {id === 'files' && busy && <i className="knowledge-activity-dot" />}
                </Button>
              ))}
            </div>
            <div className="knowledge-heading-actions">
              <span title="已加载 / 全部已发布知识页">
                {pages.length}/{snapshot?.pageCount ?? '—'} 页
              </span>
              <IconButton label="刷新状态" disabled={loading} onClick={onRefresh}>
                <RefreshCw size={14} className={loading ? 'spin' : ''} />
              </IconButton>
            </div>
          </header>
          <div
            className="knowledge-view knowledge-graph-view"
            hidden={view !== 'graph'}
            role="tabpanel"
            id={`${tabId}-graph-content`}
            aria-labelledby={`${tabId}-graph`}
          >
            <KnowledgeGraph
              pages={pages}
              selected={readerOpen ? selected?.path : undefined}
              onSelect={select}
              graphOnly={graphOnly}
              onToggleFocus={() => setGraphOnly((value) => !value)}
              floatingControls
              active={view === 'graph' && !(compact && readerOpen)}
            />
          </div>
          <div
            className="knowledge-view knowledge-catalog-view"
            hidden={view !== 'catalog'}
            role="tabpanel"
            id={`${tabId}-catalog-content`}
            aria-labelledby={`${tabId}-catalog`}
          >
            <div className="knowledge-catalog-tools">
              <SearchField label="搜索已加载知识页" value={query} onChange={setQuery} />
              <span>
                已加载 {pages.length}/{snapshot?.pageCount ?? '—'} 页
              </span>
            </div>
            <div className="knowledge-filters" role="group" aria-label="知识类型筛选">
              <Button variant="ghost" aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
                全部
              </Button>
              {Object.entries(knowledgeKinds)
                .filter(([type]) => pages.some((page) => page.type === type))
                .map(([type, entry]) => (
                  <Button
                    variant="ghost"
                    key={type}
                    aria-pressed={kind === type}
                    onClick={() => setKind(type)}
                  >
                    <i style={{ background: entry.color }} />
                    {entry.label}
                  </Button>
                ))}
            </div>
            <div className="knowledge-page-list">
              {filtered.map((entry) => (
                <Button
                  key={entry.path}
                  variant="ghost"
                  className="knowledge-page-link"
                  aria-label={`${entry.title}，${knowledgeKind(entry.type).label}，${entry.summary}`}
                  aria-pressed={readerOpen && selected?.path === entry.path}
                  onClick={() => select(entry)}
                >
                  <span
                    className="knowledge-page-kind"
                    style={{ color: knowledgeKind(entry.type).color }}
                  >
                    <FileText size={15} />
                  </span>
                  <span className="knowledge-page-copy">
                    <strong>{entry.title}</strong>
                    <span>{entry.summary}</span>
                  </span>
                  <small>{knowledgeKind(entry.type).label}</small>
                </Button>
              ))}
            </div>
            {!filtered.length && (
              <p className="knowledge-empty">
                {loading
                  ? '正在读取知识目录…'
                  : pages.length
                    ? '没有匹配的已加载知识页。'
                    : '添加资料并开始整理后，知识页会出现在这里。'}
              </p>
            )}
            {nextOffset !== null && (
              <Button
                className="knowledge-load-more"
                variant="subtle"
                disabled={paging}
                onClick={onMore}
              >
                {paging && <LoaderCircle className="spin" size={12} />}显示更多知识页
              </Button>
            )}
          </div>
          <div
            className="knowledge-view knowledge-files-view"
            hidden={view !== 'files'}
            role="tabpanel"
            id={`${tabId}-files-content`}
            aria-labelledby={`${tabId}-files`}
          >
            <KnowledgeSources
              sources={sources}
              snapshot={snapshot}
              operation={operation}
              busy={busy}
              blocked={blocked}
              loading={loading}
              editingBlocked={!!blockedReason || submitting}
              onAdd={onAdd}
              onRemove={onRemove}
              onStart={onStart}
              onCancel={onCancel}
              onRefresh={onRefresh}
            />
          </div>
        </section>
        <section
          className="knowledge-sidebar knowledge-reader-panel"
          aria-label="知识页内容"
          ref={right}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && compact && readerOpen) {
              event.stopPropagation();
              setReaderOpen(false);
            }
          }}
        >
          <header>
            {compact && readerOpen && (
              <IconButton label="返回知识浏览" onClick={() => setReaderOpen(false)}>
                <ArrowLeft size={15} />
              </IconButton>
            )}
            <span title={readerOpen ? selected?.path : undefined}>
              {readerOpen ? selected?.title : '知识页阅读'}
            </span>
            <IconButton
              label="关闭知识页内容"
              disabled={!readerOpen}
              onClick={() => setReaderOpen(false)}
            >
              <X size={14} />
            </IconButton>
          </header>
          <div className="knowledge-reader-scroll">
            {readerOpen && selected ? (
              <KnowledgeReader
                selected={selected}
                page={page}
                reading={reading}
                error={readError}
                related={related}
                onRead={onRead}
                onSelect={select}
              />
            ) : (
              <div className="knowledge-reader-empty">
                <BookOpen size={32} strokeWidth={1.1} />
                <strong>选择一页知识，继续探索</strong>
                <p>点击图谱节点或目录条目，正文将在这里展开。</p>
              </div>
            )}
          </div>
        </section>
      </div>
      {(busy || loading || submitting || view !== 'graph') && (
        <footer className="knowledge-workspace-status">
          <span>
            {submitting
              ? '正在提交整理请求…'
              : loading
                ? '正在核对资料与发布版本…'
                : busy
                  ? `资料整理进行中 · 已完成 ${operation?.completed ?? 0}/${operation?.total ?? 0}`
                  : '知识内容保存在本地'}
            {(loading || submitting || busy) && <LoaderCircle size={11} className="spin" />}
          </span>
          <span>图谱仅展示已加载知识页的明确关联</span>
        </footer>
      )}
    </div>
  );
}
