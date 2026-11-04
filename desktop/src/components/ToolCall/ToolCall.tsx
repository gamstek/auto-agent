import { useState } from 'react';
import { Check, LoaderCircle, ShieldAlert } from 'lucide-react';
import { Button } from '../Button/Button';
import { useToolCallDetail } from '../../hooks/useRunTimeline';
import { runStatusLabel, toolLabel } from '../../lib/run-labels';
import type { RunTimelineEntry } from '../../types/run-timeline';
import './ToolCall.css';

export function ToolCall({
  entry,
  sessionId,
  runId,
}: {
  entry: RunTimelineEntry;
  sessionId: string;
  runId: string;
}) {
  const [open, setOpen] = useState(false);
  const {
    data: detail,
    error,
    reload,
  } = useToolCallDetail(sessionId, runId, entry.entryId, entry.status, open && entry.hasDetail);
  const description = [entry.metadata.skill, entry.metadata.path]
    .filter((value): value is string => typeof value === 'string' && !!value)
    .join(' · ');

  return (
    <details
      className="tool-call"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {entry.status === 'running' ? (
          <LoaderCircle size={14} className="spin" />
        ) : entry.status === 'completed' ? (
          <Check size={14} />
        ) : (
          <ShieldAlert size={14} />
        )}
        <strong>{toolLabel(entry.name)}</strong>
        <span className="tool-call-description">{description}</span>
        <span className="tool-call-status">{runStatusLabel(entry.status)}</span>
        <span>{open ? '收起' : '详情'}</span>
      </summary>
      {open && (
        <div className="tool-call-body">
          {!entry.hasDetail && <p>尚未记录调用详情。</p>}
          {error && (
            <p role="alert">
              {error}{' '}
              <Button variant="ghost" onClick={reload}>
                重新读取
              </Button>
            </p>
          )}
          {entry.hasDetail && !detail && !error && <p role="status">读取调用详情…</p>}
          {detail && (
            <>
              <h4>调用参数</h4>
              {Object.hasOwn(detail, 'input') ? (
                <pre>{JSON.stringify(detail.input, null, 2)}</pre>
              ) : (
                <p>未保存调用参数。</p>
              )}
              {detail.result ? (
                <>
                  <h4>返回结果 · {runStatusLabel(detail.result.status)}</h4>
                  <pre>
                    {typeof detail.result.output === 'string'
                      ? detail.result.output
                      : JSON.stringify(detail.result.output, null, 2)}
                  </pre>
                  {detail.result.modelText !== undefined && (
                    <details>
                      <summary>提供给模型的结果内容</summary>
                      <pre>{detail.result.modelText}</pre>
                    </details>
                  )}
                  {detail.result.effect === 'unknown' && (
                    <p>外部效果未知，需要核对；该记录不代表操作已撤销。</p>
                  )}
                </>
              ) : (
                <p>尚未收到返回结果。</p>
              )}
            </>
          )}
        </div>
      )}
    </details>
  );
}
