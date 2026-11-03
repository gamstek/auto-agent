import { useEffect, useRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Session } from '../../bridge';
import { NavigationItem } from '../NavigationItem/NavigationItem';
import { Button } from '../Button/Button';
import './SessionList.css';

export function SessionList({
  sessions,
  selectedId,
  query,
  active,
  loading,
  hasMore,
  error,
  onSelect,
  onLoadMore,
  onRetry,
}: {
  sessions: Session[];
  selectedId: string;
  query: string;
  active: boolean;
  loading: boolean;
  hasMore: boolean;
  error: string;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const visible = sessions.filter((session) =>
    session.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [query]);
  useEffect(() => {
    if (!active || loading || error || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { root: scroller.current, rootMargin: '0px 0px 120px 0px' },
    );
    if (sentinel.current) observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [active, loading, error, hasMore, sessions.length, query, onLoadMore]);

  return (
    <div
      className="sessions"
      ref={scroller}
      role="region"
      aria-label="会话列表"
      aria-busy={loading}
      tabIndex={0}
    >
      {visible.map((session) => (
        <NavigationItem
          key={session.id}
          title={session.title}
          selected={selectedId === session.id}
          label={session.title === 'New session' ? '新的对话' : session.title}
          trailing={new Date(session.updatedAt).toLocaleDateString('zh-CN', {
            month: 'short',
            day: 'numeric',
          })}
          onClick={() => onSelect(session.id)}
        />
      ))}
      {!visible.length && !loading && !error && !hasMore && (
        <p className="session-list-status">{query ? '没有匹配的会话' : '你的对话会保存在这里'}</p>
      )}
      {loading && (
        <p className="session-list-status" role="status">
          <LoaderCircle className="spin" size={14} />
          正在加载会话…
        </p>
      )}
      {error && (
        <div className="session-list-error" role="alert">
          <p>{error}</p>
          <Button variant="subtle" onClick={onRetry}>
            重试加载会话
          </Button>
        </div>
      )}
      {!loading && !error && !hasMore && visible.length > 0 && (
        <p className="session-list-status">已显示全部会话</p>
      )}
      <div className="session-list-sentinel" ref={sentinel} aria-hidden="true" />
    </div>
  );
}
