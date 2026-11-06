import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatTurnDetails } from '@auto-agent/desktop-protocol';
import './ChatProgress.css';

export function formatElapsed(milliseconds: number, complete = false): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (complete && seconds === 0) return '<1s';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

export function ChatProgress({
  details,
  active,
  paused,
  status,
  expandable,
  expanded,
  onToggle,
}: {
  details: ChatTurnDetails;
  active: boolean;
  paused: boolean;
  status?: string;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [animateToggle, setAnimateToggle] = useState(false);
  useEffect(() => {
    if (!active || paused) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, paused, details.startedAt]);
  const label =
    details.endedAt !== undefined
      ? formatElapsed(details.endedAt - details.startedAt, true)
      : active
        ? `已处理 ${formatElapsed(now - details.startedAt)}`
        : '处理已中断';
  const suffix = status === 'cancelled' ? ' · 已取消' : status === 'failed' ? ' · 失败' : '';
  return (
    <div className="chat-progress">
      {expandable ? (
        <button
          type="button"
          aria-label="处理过程"
          aria-expanded={expanded}
          data-animate={animateToggle}
          onClick={(event) => {
            setAnimateToggle(event.detail > 0);
            onToggle();
          }}
          title={`本轮回复用时：${label}${suffix}`}
        >
          <span>
            {label}
            {suffix}
          </span>
          <ChevronRight size={13} className={expanded ? 'expanded' : ''} />
        </button>
      ) : (
        <span title="本轮回复用时，依据 Corax 事件时间">
          {label}
          {suffix}
        </span>
      )}
    </div>
  );
}
