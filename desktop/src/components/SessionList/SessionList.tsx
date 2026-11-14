import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Session } from '../../bridge';
import { NavigationItem } from '../NavigationItem/NavigationItem';
import { Button } from '../Button/Button';
import { SessionContextMenu } from '../SessionContextMenu/SessionContextMenu';
import { SessionRenameDialog } from '../SessionRenameDialog/SessionRenameDialog';
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
  onRename,
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
  onRename: (id: string, title: string) => Promise<void>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<Session | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const closeMenu = useCallback((restoreFocus = false) => {
    setMenu(null);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  const closeEditor = useCallback(() => {
    setEditing(null);
    trigger.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!active) {
      setMenu(null);
      setEditing(null);
    }
  }, [active]);
  const menuSession = menu ? sessions.find((session) => session.id === menu.id) : undefined;
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
          data-context-open={menu?.id === session.id}
          aria-haspopup="menu"
          aria-keyshortcuts="F2 Shift+F10"
          aria-expanded={menu?.id === session.id}
          onContextMenu={(event) => {
            event.preventDefault();
            if (!active) return;
            trigger.current = event.currentTarget;
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({
              id: session.id,
              x: event.clientX || rect.left + 24,
              y: event.clientY || rect.bottom,
            });
          }}
          onKeyDown={(event) => {
            if (!active) return;
            if (event.key === 'F2') {
              event.preventDefault();
              trigger.current = event.currentTarget;
              setMenu(null);
              setEditing(session);
            } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault();
              trigger.current = event.currentTarget;
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({ id: session.id, x: rect.left + 24, y: rect.bottom });
            }
          }}
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
      {active && menu && menuSession && (
        <SessionContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          onRename={() => {
            setMenu(null);
            setEditing(menuSession);
          }}
        />
      )}
      {active && editing && (
        <SessionRenameDialog
          key={editing.id}
          session={editing}
          onSave={onRename}
          onClose={closeEditor}
        />
      )}
    </div>
  );
}
