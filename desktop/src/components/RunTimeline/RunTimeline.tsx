import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRunTimeline } from '../../hooks/useRunTimeline';
import { runStatusLabel } from '../../lib/run-labels';
import { Button } from '../Button/Button';
import { MarkdownAnswer } from '../MarkdownAnswer/MarkdownAnswer';
import { ToolCall } from '../ToolCall/ToolCall';
import './RunTimeline.css';

interface RunTimelineProps {
  sessionId: string;
  runId: string;
  running?: boolean;
  finalText?: string;
  onUpdate?: () => void;
}

/** One run's ordered model/tool history, inside a single assistant message. */
export function RunTimeline({
  sessionId,
  runId,
  running = false,
  finalText,
  onUpdate,
}: RunTimelineProps) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(running);
  const update = useRef(onUpdate);
  update.current = onUpdate;
  const { data, error, reload } = useRunTimeline(sessionId, runId, running, visible);

  useEffect(() => {
    if (visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, [visible]);
  useLayoutEffect(() => {
    update.current?.();
  }, [data]);

  const lastModel = data?.entries.filter((entry) => entry.kind === 'model').at(-1)?.entryId;
  return (
    <div ref={container} className="run-timeline" aria-label="完整处理过程">
      {error && (
        <p role="alert">
          {error}{' '}
          <Button variant="ghost" onClick={reload}>
            重新读取过程
          </Button>
        </p>
      )}
      {!data && !error && (
        <p role={visible ? 'status' : undefined}>{visible ? '读取处理过程…' : '处理过程'}</p>
      )}
      {data && (
        <>
          {!!data.entries.length && (
            <details className="run-timeline-entries" open>
              <summary>
                处理过程 · {data.entries.length} 个步骤
                {data.run.status === 'running' ? ' · 执行中' : ''}
              </summary>
              {data.entries.map((entry) =>
                entry.kind === 'tool' ? (
                  <ToolCall key={entry.entryId} entry={entry} sessionId={sessionId} runId={runId} />
                ) : (
                  <section className="run-timeline-model" key={entry.entryId}>
                    <div className="run-timeline-model-label">
                      模型 · 第 {entry.step ?? '?'} 轮 <span>{runStatusLabel(entry.status)}</span>
                    </div>
                    {entry.reasoning && (
                      <details className="thinking">
                        <summary>思考过程</summary>
                        <p>{entry.reasoning}</p>
                      </details>
                    )}
                    {entry.text && !(entry.entryId === lastModel && entry.text === finalText) && (
                      <MarkdownAnswer text={entry.text} />
                    )}
                  </section>
                ),
              )}
            </details>
          )}
          {!data.entries.length && (
            <p>{running ? '正在准备模型与工具…' : '本轮在模型或工具调用前结束。'}</p>
          )}
        </>
      )}
    </div>
  );
}
