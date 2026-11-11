import {
  CheckCheck,
  FileText,
  FolderOpen,
  Library,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import type { KnowledgeSnapshot, KnowledgeOperation } from '@auto-agent/desktop-protocol';
import type { Settings } from '../../bridge';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import './KnowledgeSources.css';

const states = {
  pending: '待整理',
  ready: '已整理',
  changed: '需要更新',
  error: '需要核对',
  empty: '没有可整理文件',
};
const phases = {
  discovering: '读取资料',
  checking: '检查已有知识',
  analysis: '分析资料',
  generation: '生成知识页',
  publishing: '校验并发布',
};

export function KnowledgeSources({
  sources,
  snapshot,
  operation,
  busy,
  blocked,
  loading,
  editingBlocked,
  onAdd,
  onRemove,
  onStart,
  onCancel,
  onRefresh,
}: {
  sources: Settings['llmWiki']['sources'];
  snapshot?: KnowledgeSnapshot;
  operation?: KnowledgeOperation | null;
  busy: boolean;
  blocked: boolean;
  loading: boolean;
  editingBlocked: boolean;
  onAdd: (kind: 'file' | 'directory') => void;
  onRemove: (id: string) => void;
  onStart: (id?: string) => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="knowledge-sources">
      <section className="knowledge-source-card" aria-label="资料来源">
        <header>
          <div>
            <Library size={16} />
            <h2>资料来源</h2>
          </div>
          <div className="knowledge-source-header-actions">
            <span>{sources.length} 个</span>
            <IconButton label="刷新资料状态" disabled={loading} onClick={onRefresh}>
              <RefreshCw size={13} />
            </IconButton>
          </div>
        </header>
        <p className="knowledge-source-help">添加只保存来源，开始整理才会调用模型。</p>
        <div className="knowledge-source-add">
          <Button variant="subtle" disabled={editingBlocked || busy} onClick={() => onAdd('file')}>
            <FileText size={14} />
            添加文件
          </Button>
          <Button
            variant="subtle"
            disabled={editingBlocked || busy}
            onClick={() => onAdd('directory')}
          >
            <FolderOpen size={14} />
            添加文件夹
          </Button>
        </div>
        {!sources.length && (
          <div className="knowledge-source-empty">
            <FolderOpen size={26} strokeWidth={1.2} />
            <p>还没有资料来源</p>
            <span>支持 Markdown、TXT 文件或文件夹</span>
          </div>
        )}
        <div className="knowledge-source-list">
          {sources.map((source) => {
            const status = snapshot?.sources.find((entry) => entry.id === source.id);
            const Icon = source.type === 'directory' ? FolderOpen : FileText;
            return (
              <article className="knowledge-source" key={source.id}>
                <div className="knowledge-source-heading">
                  <Icon size={15} />
                  <strong title={source.path}>{source.path.split(/[\\/]/).pop()}</strong>
                  <IconButton
                    label={`移除 ${source.path}`}
                    disabled={editingBlocked || busy}
                    onClick={() => onRemove(source.id)}
                  >
                    <X size={13} />
                  </IconButton>
                </div>
                <code title={source.path}>{source.path}</code>
                <div className="knowledge-source-detail">
                  <span className="knowledge-status" data-state={status?.status ?? 'unknown'}>
                    {status ? states[status.status] : loading ? '正在核对' : '状态未知'}
                  </span>
                  {status && (
                    <span>
                      {status.ready}/{status.documents} 份资料已整理
                    </span>
                  )}
                </div>
                {status?.ingestedAt && (
                  <p>最近整理 · {new Date(status.ingestedAt).toLocaleDateString('zh-CN')}</p>
                )}
                {status?.message && <p className="knowledge-notice">{status.message}</p>}
                <Button
                  variant="subtle"
                  disabled={blocked || status?.status === 'empty'}
                  onClick={() => onStart(source.id)}
                >
                  {status?.status === 'ready' ? '重新检查并整理' : '开始整理'}
                </Button>
              </article>
            );
          })}
        </div>
        {sources.length > 1 && (
          <Button
            className="knowledge-organize-all"
            variant="primary"
            disabled={blocked}
            onClick={() => onStart()}
          >
            <CheckCheck size={14} />
            整理全部资料
          </Button>
        )}
      </section>
      {operation && (
        <section className="knowledge-operation" aria-label="整理结果" role="status">
          <div className="knowledge-operation-title">
            {busy ? <LoaderCircle className="spin" size={15} /> : <CheckCheck size={15} />}
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
          </div>
          {busy && (
            <progress
              aria-label="资料整理进度"
              max={Math.max(1, operation.total)}
              value={operation.total ? operation.completed : undefined}
            />
          )}
          <p>
            已完成 {operation.completed}/{operation.total} 份资料，涉及 {operation.pageCount}{' '}
            个知识页，复用 {operation.reused} 份。
          </p>
          {busy && operation.source && (
            <p className="knowledge-operation-source">{operation.source}</p>
          )}
          {operation.failedSource && <p>未完成来源：{operation.failedSource}</p>}
          {operation.message && <p>{operation.message}</p>}
          {operation.state !== 'completed' && !busy && (
            <p>此前已发布的内容仍保留，请核对结果后再决定是否重新整理。</p>
          )}
          {busy && (
            <Button variant="subtle" disabled={operation.state === 'cancelling'} onClick={onCancel}>
              取消整理
            </Button>
          )}
        </section>
      )}
      <p className="knowledge-source-footnote">移除来源只取消后续整理，不删除已发布知识。</p>
    </div>
  );
}
