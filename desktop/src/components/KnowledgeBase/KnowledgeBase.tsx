import { useEffect, useRef, useState } from 'react';
import { FolderOpen, LoaderCircle, RefreshCw, X } from 'lucide-react';
import type {
  KnowledgeSnapshot,
  KnowledgeOperationState,
  KnowledgeOperation,
  KnowledgePage,
  KnowledgePageEntry,
} from '@auto-agent/desktop-protocol';
import { api, errorText, type Settings } from '../../bridge';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { MarkdownAnswer } from '../MarkdownAnswer/MarkdownAnswer';
import { SettingsSection as Group, SettingsRow as Row } from '../SettingsSection/SettingsSection';
import './KnowledgeBase.css';

const running = (operation?: KnowledgeOperation | null) =>
  !!operation && ['running', 'cancelling'].includes(operation.state);
const phases = {
  discovering: '读取资料',
  checking: '检查已有知识',
  analysis: '分析资料',
  generation: '生成知识页',
  publishing: '校验并发布',
};
const states = {
  pending: '待整理',
  ready: '已整理',
  changed: '需要更新',
  error: '需要核对',
  empty: '没有可整理文件',
};

export function KnowledgeBase({
  sources,
  onAdd,
  onRemove,
  configRevision,
  blockedReason,
  refreshKey,
  active,
}: {
  sources: Settings['llmWiki']['sources'];
  onAdd: (kind: 'file' | 'directory') => void;
  onRemove: (id: string) => void;
  configRevision?: string;
  blockedReason?: string;
  refreshKey: number;
  active: boolean;
}) {
  const [snapshot, setSnapshot] = useState<KnowledgeSnapshot>();
  const [operationState, setOperationState] = useState<KnowledgeOperationState>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pages, setPages] = useState<KnowledgePageEntry[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [page, setPage] = useState<KnowledgePage>();
  const [reading, setReading] = useState(false);
  const revision = useRef(0);
  const alive = useRef(true);
  const actionLock = useRef(false);
  const operation = operationState?.operation;
  const busy = running(operation);
  const revisionMismatch = !!operationState && operationState.configRevision !== configRevision;
  const blocked =
    !!blockedReason ||
    revisionMismatch ||
    submitting ||
    busy ||
    !snapshot ||
    !!operationState?.admissionUncertain;

  async function refresh() {
    const request = ++revision.current;
    setLoading(true);
    setSnapshot(undefined);
    setPage(undefined);
    setPages([]);
    setNextOffset(null);
    try {
      const value = await api<KnowledgeSnapshot>('/knowledge');
      if (!alive.current || request !== revision.current) return;
      setSnapshot(value);
      setOperationState(value);
      setPages(value.pages.filter((entry) => entry.type !== 'navigation'));
      setNextOffset(value.nextOffset);
      setPage(undefined);
      setError('');
    } catch (cause) {
      if (alive.current && request === revision.current) setError(errorText(cause));
    } finally {
      if (alive.current && request === revision.current) setLoading(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      revision.current++;
    };
  }, []);
  useEffect(() => {
    if (active && !blockedReason) void refresh();
  }, [active, configRevision, refreshKey, blockedReason]);
  useEffect(() => {
    if (!active || !busy) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const request = revision.current;
      try {
        const value = await api<KnowledgeOperationState>('/knowledge/operation');
        if (disposed) return;
        if (request !== revision.current) {
          timer = setTimeout(() => void poll(), 400);
          return;
        }
        setOperationState(value);
        if (value.generation !== operationState?.generation) {
          await refresh();
          if (!disposed) setError('后端连接已变化，请核对已发布资料；未自动重新整理。');
          return;
        }
        if (!running(value.operation)) {
          await refresh();
          return;
        }
      } catch (cause) {
        if (!disposed) setError(errorText(cause));
      }
      if (!disposed) timer = setTimeout(() => void poll(), 800);
    };
    timer = setTimeout(() => void poll(), 400);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [active, busy, operation?.id, operationState?.generation]);

  async function start(sourceId?: string) {
    if (blocked || actionLock.current || !operationState) return;
    revision.current++;
    setLoading(false);
    actionLock.current = true;
    setSubmitting(true);
    setError('');
    try {
      const value = await api<KnowledgeOperationState>('/knowledge/ingest', 'POST', {
        sourceId,
        configRevision,
        generation: operationState.generation,
      });
      if (alive.current) setOperationState(value);
    } catch (cause) {
      if (alive.current) {
        await refresh();
        setError(`${errorText(cause)}。未自动重试，请刷新状态核对结果。`);
      }
    } finally {
      actionLock.current = false;
      if (alive.current) setSubmitting(false);
    }
  }
  async function cancel() {
    if (!operation || !operationState || actionLock.current) return;
    revision.current++;
    setLoading(false);
    actionLock.current = true;
    try {
      const value = await api<KnowledgeOperationState>('/knowledge/cancel', 'POST', {
        operationId: operation.id,
        generation: operationState.generation,
      });
      if (alive.current) setOperationState(value);
    } catch (cause) {
      if (alive.current) setError(errorText(cause));
    } finally {
      actionLock.current = false;
    }
  }
  async function read(entry: KnowledgePageEntry | KnowledgePage, offset = 0) {
    const request = revision.current;
    setReading(true);
    try {
      const value = await api<KnowledgePage>('/knowledge/read', 'POST', {
        reference: entry.reference,
        offset,
      });
      if (alive.current && request === revision.current)
        setPage((previous) =>
          offset && previous?.reference.sha256 === value.reference.sha256
            ? { ...value, text: `${previous.text}\n${value.text}`, startLine: previous.startLine }
            : value,
        );
    } catch (cause) {
      if (alive.current) setError(errorText(cause));
    } finally {
      if (alive.current) setReading(false);
    }
  }
  async function more() {
    if (nextOffset === null || reading) return;
    const request = revision.current;
    setReading(true);
    try {
      const value = await api<{ pages: KnowledgePageEntry[]; nextOffset: number | null }>(
        `/knowledge/pages?offset=${nextOffset}${snapshot?.publication ? `&generation=${snapshot.publication}` : ''}`,
      );
      if (alive.current && request === revision.current) {
        setPages((previous) => [
          ...previous,
          ...value.pages.filter((entry) => entry.type !== 'navigation'),
        ]);
        setNextOffset(value.nextOffset);
      }
    } catch (cause) {
      if (alive.current) setError(errorText(cause));
    } finally {
      if (alive.current) setReading(false);
    }
  }

  return (
    <div className="knowledge-base">
      <p className="settings-section-note">
        添加资料只保存来源。点击“开始整理”后，使用当前模型分析资料并生成持久知识页。
      </p>
      <Group title="资料来源">
        <Row
          label="添加资料"
          description="支持 UTF-8 Markdown/TXT 文件或文件夹。"
          wide
          control={
            <div className="knowledge-actions">
              <Button
                variant="subtle"
                disabled={!!blockedReason || busy}
                onClick={() => onAdd('file')}
              >
                添加文件
              </Button>
              <Button
                variant="subtle"
                disabled={!!blockedReason || busy}
                onClick={() => onAdd('directory')}
              >
                <FolderOpen size={15} />
                添加文件夹
              </Button>
            </div>
          }
        />
        {!sources.length && <p className="knowledge-empty">还没有资料。先添加文件，再开始整理。</p>}
        {sources.map((source) => {
          const status = snapshot?.sources.find((entry) => entry.id === source.id);
          return (
            <div className="knowledge-source" key={source.id}>
              <div className="knowledge-source-heading">
                <strong>{source.path.split(/[\\/]/).pop()}</strong>
                <span className="knowledge-status" data-state={status?.status ?? 'unknown'}>
                  {status ? states[status.status] : loading ? '正在核对' : '状态未知'}
                </span>
              </div>
              <code title={source.path}>{source.path}</code>
              {status && (
                <p>
                  {status.ready}/{status.documents} 份资料已整理
                  {status.ingestedAt
                    ? ` · 最近处理 ${new Date(status.ingestedAt).toLocaleString()}`
                    : ''}
                </p>
              )}
              {status?.message && <p className="knowledge-notice">{status.message}</p>}
              <div className="knowledge-actions">
                <Button
                  variant="subtle"
                  disabled={blocked || status?.status === 'empty'}
                  onClick={() => void start(source.id)}
                >
                  {status?.status === 'ready' ? '重新检查并整理' : '开始整理'}
                </Button>
                <IconButton
                  label={`移除 ${source.path}`}
                  disabled={!!blockedReason || busy}
                  onClick={() => onRemove(source.id)}
                >
                  <X size={14} />
                </IconButton>
              </div>
            </div>
          );
        })}
      </Group>
      <div className="knowledge-actions">
        {sources.length > 1 && (
          <Button variant="primary" disabled={blocked} onClick={() => void start()}>
            整理全部资料
          </Button>
        )}
        <Button variant="subtle" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw size={14} />
          刷新状态
        </Button>
        {(loading || submitting) && (
          <span role="status">
            <LoaderCircle className="spin" size={14} />
            {submitting ? '正在提交整理请求…' : '正在核对资料…'}
          </span>
        )}
      </div>
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
      {operation && (
        <section className="knowledge-operation" aria-label="整理结果" role="status">
          <strong>
            {operation.state === 'running'
              ? phases[operation.phase]
              : operation.state === 'cancelling'
                ? '正在取消，等待当前处理结束'
                : operation.state === 'completed'
                  ? '整理完成'
                  : operation.state === 'cancelled'
                    ? '整理已取消'
                    : '整理未完成'}
          </strong>
          <p>
            已完成 {operation.completed}/{operation.total} 份资料，涉及 {operation.pageCount}{' '}
            个知识页，复用 {operation.reused} 份。
          </p>
          {busy && operation.source && <p>{operation.source}</p>}
          {operation.failedSource && <p>未完成来源：{operation.failedSource}</p>}
          {operation.message && <p>{operation.message}</p>}
          {operation.state !== 'completed' && !busy && (
            <p>此前已发布的内容仍保留，请核对结果后再决定是否重新整理。</p>
          )}
          {busy && (
            <Button
              variant="subtle"
              disabled={operation.state === 'cancelling'}
              onClick={() => void cancel()}
            >
              取消整理
            </Button>
          )}
        </section>
      )}
      <Group title={snapshot ? `已生成知识页（${snapshot.pageCount}）` : '知识页目录'}>
        {snapshot && !snapshot.published && (
          <p className="knowledge-empty">尚未生成知识页。添加来源后，点击“开始整理”。</p>
        )}
        {snapshot?.wikiDirectory && (
          <p className="knowledge-directory">
            保存位置：<code>{snapshot.wikiDirectory}</code>
          </p>
        )}
        {pages.map((entry) => (
          <Button
            className="knowledge-page-link"
            variant="ghost"
            key={entry.path}
            disabled={reading}
            onClick={() => void read(entry)}
          >
            <strong>{entry.title}</strong>
            <span>{entry.summary}</span>
          </Button>
        ))}
        {nextOffset !== null && (
          <Button variant="subtle" disabled={reading} onClick={() => void more()}>
            显示更多知识页
          </Button>
        )}
      </Group>
      {page && (
        <section className="knowledge-preview" aria-label="知识页内容">
          <header>
            <h2>{page.title}</h2>
            <IconButton label="关闭知识页" onClick={() => setPage(undefined)}>
              <X size={14} />
            </IconButton>
          </header>
          <MarkdownAnswer text={page.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')} />
          {page.nextOffset !== null && (
            <Button
              variant="subtle"
              disabled={reading}
              onClick={() => void read(page, page.nextOffset!)}
            >
              继续阅读
            </Button>
          )}
        </section>
      )}
      <p className="settings-section-note">
        移除来源只取消后续整理，不删除已生成知识。知识页是模型整理内容，重要事实应结合原文核对。
      </p>
    </div>
  );
}
