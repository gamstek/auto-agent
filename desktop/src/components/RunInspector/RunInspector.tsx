import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import {
  api,
  errorText,
  type BackendHealth,
  assertDesktopProtocol,
} from '../../bridge';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import './RunInspector.css';

type Run = { id: string; status: string; createdAt: number };
type Node = {
  nodeId: string;
  kind: string;
  label: string;
  status: string;
  hasRequest: boolean;
  details: Record<string, unknown>;
};
type Graph = {
  nodes: string[];
  edges: { source: string; target: string; conditional: boolean }[];
  mermaid: string;
};
type Trace = { run: { id: string; status: string }; graph: Graph | null; nodes: Node[] };
type Snapshot = {
  truncated: boolean;
  originalBytes: number;
  preview?: string;
  reason?: string;
  request?: {
    model: string;
    payload: {
      messages: { role: string; content: unknown }[];
      tools: unknown;
      maxOutputTokens: number;
    };
  };
};
const statuses: Record<string, string> = {
  running: '进行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  timeout: '超时',
  unknown: '效果未知',
  waiting_for_operator: '等待对账',
  interrupted: '已中断',
  dependency_blocked: '依赖阻断',
};
const nodeLabel = (name: string) =>
  ({ __start__: '开始', model: '模型', tools: '工具', __end__: '结束' })[name] ?? name;

function PromptMessage({
  message,
  index,
}: {
  message: { role: string; content: unknown };
  index: number;
}) {
  const [expanded, setExpanded] = useState(message.role === 'system');
  return (
    <details
      className="trace-prompt-message"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {index + 1}. {message.role}
      </summary>
      {expanded && (
        <pre>
          {typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content, null, 2)}
        </pre>
      )}
    </details>
  );
}

export function RunInspector({
  sessionId,
  running,
  onClose,
}: {
  sessionId: string;
  running: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [runId, setRunId] = useState('');
  const [trace, setTrace] = useState<Trace | null>(null);
  const [nodeId, setNodeId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [requestError, setRequestError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const olderExhausted = useRef(false);
  const selected = trace?.nodes.find((node) => node.nodeId === nodeId);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let disposed = false,
      pending = false;
    async function sync() {
      if (pending) return;
      pending = true;
      try {
        const health = await api<BackendHealth>('/global/health');
        assertDesktopProtocol(health);
        const list = await api<Run[]>(`/session/${sessionId}/runs?limit=50`);
        if (disposed) return;
        setRuns((old) => {
          const merged = new Map(old.map((item) => [item.id, item]));
          for (const item of list) merged.set(item.id, item);
          return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
        });
        setHasMore(list.length === 50 && !olderExhausted.current);
        setRunId((old) => old || list[0]?.id || '');
        setError('');
      } catch (e) {
        if (!disposed) setError(errorText(e));
      } finally {
        pending = false;
      }
    }
    void sync();
    const timer = running ? setInterval(() => void sync(), 1500) : undefined;
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, running, refresh]);
  useEffect(() => {
    setTrace(null);
    setNodeId('');
    setSnapshot(null);
  }, [sessionId, runId]);
  useEffect(() => {
    if (!runId) return;
    let disposed = false,
      pending = false;
    async function sync() {
      if (pending) return;
      pending = true;
      try {
        const value = await api<Trace>(`/session/${sessionId}/runs/${runId}/trace`);
        if (disposed) return;
        setTrace(value);
        setNodeId(
          (old) =>
            old ||
            value.nodes.find((node) => node.hasRequest)?.nodeId ||
            value.nodes[0]?.nodeId ||
            '',
        );
        setError('');
      } catch (e) {
        if (!disposed) setError(errorText(e));
      } finally {
        pending = false;
      }
    }
    void sync();
    const timer = running ? setInterval(() => void sync(), 1000) : undefined;
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, runId, running, refresh]);
  useEffect(() => {
    setSnapshot(null);
    setRequestError('');
    setLoading(false);
    if (!runId || !nodeId || !selected?.hasRequest) return;
    let disposed = false;
    setLoading(true);
    void api<Snapshot>(
      `/session/${sessionId}/runs/${runId}/trace?node=${encodeURIComponent(nodeId)}`,
    )
      .then((value) => {
        if (!disposed) setSnapshot(value);
      })
      .catch((e) => {
        if (!disposed) setRequestError(errorText(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, runId, nodeId, selected?.hasRequest, refresh]);
  async function more() {
    setLoadingMore(true);
    try {
      const list = await api<Run[]>(`/session/${sessionId}/runs?limit=50&offset=${runs.length}`);
      setRuns((old) => [...new Map([...old, ...list].map((item) => [item.id, item])).values()]);
      setHasMore(list.length === 50);
      olderExhausted.current = list.length < 50;
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  }
  const graph = trace?.graph;
  const position = (id: string) => 90 + Math.max(0, graph?.nodes.indexOf(id) ?? 0) * 160;
  function selectKind(id: string) {
    const node = trace?.nodes
      .slice()
      .reverse()
      .find((entry) => entry.kind === (id === 'tools' ? 'tool' : id));
    if (node) setNodeId(node.nodeId);
  }
  return (
    <dialog
      ref={dialog}
      className="run-inspector"
      aria-labelledby="run-inspector-title"
      onCancel={onClose}
    >
      <header className="run-inspector-header">
        <div>
          <h2 id="run-inspector-title">运行图与提示词</h2>
          <p>LangGraph 实际拓扑 · 本地脱敏请求快照（SDK 序列化前）</p>
        </div>
        <IconButton label="关闭运行图" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </header>
      <div className="run-inspector-controls">
        <label>
          运行记录
          <select
            aria-label="选择运行记录"
            value={runId}
            onChange={(event) => setRunId(event.target.value)}
          >
            {!runs.length && <option value="">{error ? '运行记录不可用' : '暂无运行记录'}</option>}
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {new Date(run.createdAt).toLocaleString()} · {statuses[run.status] ?? run.status} ·{' '}
                {run.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {hasMore && (
          <Button variant="ghost" disabled={loadingMore} onClick={() => void more()}>
            更早记录
          </Button>
        )}
        <IconButton label="刷新运行图" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={16} />
        </IconButton>
      </div>
      {error && (
        <p role="alert" className="run-inspector-error">
          {error}
        </p>
      )}
      {graph && (
        <div className="run-graph">
          <svg
            viewBox={`0 0 ${graph.nodes.length * 160 + 20} 145`}
            role="img"
            aria-label="LangGraph 节点拓扑"
          >
            <defs>
              <marker
                id="trace-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {graph.edges.map((edge, index) => {
              const x = position(edge.source),
                y = position(edge.target);
              return (
                <path
                  key={index}
                  className={`run-graph-edge ${edge.conditional ? 'conditional' : ''}`}
                  markerEnd="url(#trace-arrow)"
                  d={
                    y > x
                      ? `M ${x + 48} 65 C ${x + 80} ${y - x > 170 ? 0 : 65}, ${y - 80} ${y - x > 170 ? 0 : 65}, ${y - 48} 65`
                      : `M ${x} 85 C ${x} 135, ${y} 135, ${y} 85`
                  }
                />
              );
            })}
            {graph.nodes.map((name) => (
              <g
                key={name}
                role="button"
                tabIndex={0}
                aria-label={`查看 ${name} 节点`}
                onClick={() => selectKind(name)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectKind(name);
                  }
                }}
                className={
                  (selected?.kind === 'tool' ? 'tools' : selected?.kind) === name ? 'selected' : ''
                }
              >
                <rect x={position(name) - 48} y="45" width="96" height="40" rx="10" />
                <text x={position(name)} y="70" textAnchor="middle">
                  {nodeLabel(name)}
                </text>
              </g>
            ))}
          </svg>
          <details>
            <summary>LangGraph Mermaid 定义</summary>
            <pre>{graph.mermaid}</pre>
          </details>
        </div>
      )}
      <div className="run-inspector-body">
        <nav aria-label="节点调用" className="run-node-list">
          {trace?.nodes.map((node) => (
            <button
              key={node.nodeId}
              className={nodeId === node.nodeId ? 'selected' : ''}
              aria-pressed={nodeId === node.nodeId}
              onClick={() => setNodeId(node.nodeId)}
            >
              <strong>{node.label}</strong>
              <span>{statuses[node.status] ?? node.status}</span>
            </button>
          ))}
          {trace && !trace.nodes.length && (
            <p>此运行尚无节点记录。</p>
          )}
        </nav>
        <section className="run-node-detail" aria-label="节点详情">
          {selected && (
            <>
              <h3>{selected.label}</h3>
              <p>{statuses[selected.status] ?? selected.status}</p>
              {loading && <p role="status">正在读取提示词…</p>}
              {requestError && <p role="alert">{requestError}</p>}
              {!selected.hasRequest && (
                <p>
                  {selected.kind === 'tool'
                    ? '工具节点执行工具，不向 AI 发送提示词。其结果会出现在后续模型节点的消息中。'
                    : '此节点尚未发起模型请求，或快照不可用。'}
                </p>
              )}
              {snapshot?.truncated && (
                <p role="status">
                  请求快照超出存储限额，仅保存部分信息（原始{' '}
                  {snapshot.originalBytes.toLocaleString()} 字节）。这不影响实际模型输入。
                </p>
              )}
              {snapshot?.preview && <pre>{snapshot.preview}</pre>}
              {snapshot?.request && (
                <>
                  <p>
                    模型：{snapshot.request.model} · 输出上限：
                    {snapshot.request.payload.maxOutputTokens}
                  </p>
                  {snapshot.request.payload.messages.map((message, index) => (
                    <PromptMessage key={`${nodeId}:${index}`} message={message} index={index} />
                  ))}
                  <details className="trace-prompt-message">
                    <summary>工具定义</summary>
                    <pre>{JSON.stringify(snapshot.request.payload.tools, null, 2)}</pre>
                  </details>
                </>
              )}
              <details className="trace-prompt-message">
                <summary>节点事件详情</summary>
                <pre>{JSON.stringify(selected.details, null, 2)}</pre>
              </details>
            </>
          )}
          {!selected && <p>选择一次运行和节点，查看实际发送的提示词、上下文及工具定义。</p>}
        </section>
      </div>
    </dialog>
  );
}
