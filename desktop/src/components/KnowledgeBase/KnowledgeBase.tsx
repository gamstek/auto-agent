import { useEffect, useRef, useState } from 'react';
import type {
  KnowledgeSnapshot,
  KnowledgeOperationState,
  KnowledgeOperation,
  KnowledgePage,
  KnowledgePageEntry,
} from '@auto-agent/desktop-protocol';
import { api, errorText, type Settings } from '../../bridge';
import { KnowledgeWorkspace } from '../KnowledgeWorkspace/KnowledgeWorkspace';

const running = (operation?: KnowledgeOperation | null) =>
  !!operation && ['running', 'cancelling'].includes(operation.state);

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
  const [paging, setPaging] = useState(false);
  const [readError, setReadError] = useState('');
  const readRequest = useRef(0);
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
    readRequest.current++;
    setReading(false);
    setReadError('');
    setPaging(false);
    setSnapshot(undefined);
    setPage(undefined);
    setPages([]);
    setNextOffset(null);
    try {
      const value = await api<KnowledgeSnapshot>('/knowledge');
      if (!alive.current || request !== revision.current) return;
      if (value.pages.some((entry) => entry.reference.generation !== value.publication))
        throw new Error('知识目录发布版本不一致，请刷新后核对。');
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
    const selection = ++readRequest.current;
    setReading(true);
    setReadError('');
    if (!offset) setPage(undefined);
    try {
      const value = await api<KnowledgePage>('/knowledge/read', 'POST', {
        reference: entry.reference,
        offset,
      });
      if (
        value.reference.generation !== entry.reference.generation ||
        value.reference.path !== entry.reference.path ||
        value.reference.sha256 !== entry.reference.sha256
      )
        throw new Error('知识页返回的固定引用不一致，请关闭后重新读取。');
      if (alive.current && request === revision.current && selection === readRequest.current)
        setPage((previous) =>
          offset &&
          previous?.reference.sha256 === value.reference.sha256 &&
          previous.reference.path === value.reference.path &&
          previous.reference.generation === value.reference.generation
            ? { ...value, text: `${previous.text}\n${value.text}`, startLine: previous.startLine }
            : value,
        );
    } catch (cause) {
      if (alive.current && request === revision.current && selection === readRequest.current)
        setReadError(errorText(cause));
    } finally {
      if (alive.current && selection === readRequest.current) setReading(false);
    }
  }
  async function more() {
    if (nextOffset === null || paging) return;
    const request = revision.current;
    setPaging(true);
    try {
      const value = await api<{ pages: KnowledgePageEntry[]; nextOffset: number | null }>(
        `/knowledge/pages?offset=${nextOffset}${snapshot?.publication ? `&generation=${snapshot.publication}` : ''}`,
      );
      if (alive.current && request === revision.current) {
        if (value.pages.some((entry) => entry.reference.generation !== snapshot?.publication))
          throw new Error('知识目录发布版本不一致，请刷新后核对。');
        setPages((previous) => [
          ...new Map(
            [...previous, ...value.pages.filter((entry) => entry.type !== 'navigation')].map(
              (entry) => [entry.path, entry],
            ),
          ).values(),
        ]);
        setNextOffset(value.nextOffset);
      }
    } catch (cause) {
      if (alive.current && request === revision.current) setError(errorText(cause));
    } finally {
      if (alive.current && request === revision.current) setPaging(false);
    }
  }

  return (
    <KnowledgeWorkspace
      sources={sources}
      snapshot={snapshot}
      operationState={operationState}
      blockedReason={blockedReason}
      revisionMismatch={revisionMismatch}
      blocked={blocked}
      busy={busy}
      loading={loading}
      submitting={submitting}
      error={error}
      pages={pages}
      nextOffset={nextOffset}
      paging={paging}
      page={page}
      reading={reading}
      readError={readError}
      resetKey={revision.current}
      onAdd={onAdd}
      onRemove={onRemove}
      onRefresh={() => void refresh()}
      onStart={(id) => void start(id)}
      onCancel={() => void cancel()}
      onRead={(entry, offset) => void read(entry, offset)}
      onMore={() => void more()}
      onClosePage={() => {
        readRequest.current++;
        setPage(undefined);
        setReading(false);
        setReadError('');
      }}
    />
  );
}
