import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, SquareTerminal, Wrench } from 'lucide-react';
import type {
  CoraxDynamicToolPart,
  ConversationState,
  ChatCallState,
} from '@auto-agent/desktop-protocol';
import { ChatTool } from '../ChatTool/ChatTool';
import './ChatToolGroup.css';

export function ChatToolGroup({
  parts,
  conversation,
  calls,
  openCalls,
  onToggleCall,
  paused,
}: {
  parts: readonly CoraxDynamicToolPart[];
  conversation: ConversationState;
  calls: Readonly<Record<string, ChatCallState>>;
  openCalls: ReadonlySet<string>;
  onToggleCall: (id: string, open: boolean) => void;
  paused: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const view = useRef<HTMLDivElement>(null);
  const items = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [overflowBottom, setOverflowBottom] = useState(false);
  const grouped = parts.length > 1;
  const statuses = parts.map((part) => calls[part.toolCallId]!.status);
  const active = statuses.includes('running');
  const open =
    !grouped || (expanded ?? (active || parts.some((part) => openCalls.has(part.toolCallId))));
  const commands = parts.every(
    (part) => (part.toolMetadata?.corax?.name ?? part.toolName) === 'bash',
  );
  const attention = statuses.filter((status) =>
    ['failed', 'rejected', 'interrupted'].includes(status),
  ).length;
  const Icon = commands ? SquareTerminal : Wrench;
  useLayoutEffect(() => {
    if (active && open && follow.current && view.current)
      view.current.scrollTop = view.current.scrollHeight;
  }, [parts.length, active, open]);
  function measureOverflow() {
    const element = view.current;
    setOverflowBottom(
      !!element &&
        element.clientHeight > 0 &&
        element.scrollHeight - element.scrollTop - element.clientHeight > 2,
    );
  }
  useLayoutEffect(() => {
    if (!grouped || !open) {
      setOverflowBottom(false);
      return;
    }
    const observer = new ResizeObserver(measureOverflow);
    if (view.current) observer.observe(view.current);
    if (items.current) observer.observe(items.current);
    measureOverflow();
    return () => observer.disconnect();
  }, [grouped, open]);

  return (
    <section
      className="chat-tool-group"
      data-grouped={grouped}
      data-overflow-bottom={overflowBottom}
    >
      {grouped && (
        <button
          type="button"
          className="chat-tool-group-heading"
          aria-label={`工具调用组（${parts.length}次）`}
          aria-expanded={open}
          onClick={() => setExpanded(!open)}
        >
          <Icon size={14} />
          <span>{commands ? (active ? '运行命令' : '运行了命令') : '工具调用'}</span>
          <span>
            {parts.length} 次{attention ? ` · ${attention} 项需查看` : ''}
          </span>
          <ChevronDown size={13} className={open ? 'expanded' : ''} />
        </button>
      )}
      <div
        className="chat-tool-group-list"
        hidden={!open}
        ref={view}
        onScroll={() => {
          const element = view.current!;
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          measureOverflow();
        }}
      >
        <div ref={items}>
          {parts.map((part) => (
            <ChatTool
              key={part.toolCallId}
              part={part}
              conversation={conversation}
              callState={calls[part.toolCallId]!}
              paused={paused}
              open={openCalls.has(part.toolCallId)}
              onOpenChange={(value) => {
                if (value) setExpanded(true);
                onToggleCall(part.toolCallId, value);
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
