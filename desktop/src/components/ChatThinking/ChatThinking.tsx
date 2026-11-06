import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MarkdownAnswer } from '../MarkdownAnswer/MarkdownAnswer';
import './ChatThinking.css';
import { ProcessingLabel } from '../ProcessingLabel/ProcessingLabel';

export function ChatThinking({
  text,
  streaming,
  paused = false,
  onOpen,
}: {
  text: string;
  streaming: boolean;
  paused?: boolean;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="chat-thinking" data-streaming={streaming && !paused}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
      >
        <ProcessingLabel
          active={streaming && !paused}
          text={streaming ? (paused ? '思考过程（等待连接）' : '正在思考') : '思考过程'}
        />
        <ChevronDown size={14} className={open ? 'expanded' : ''} />
      </button>
      {open && (
        <div className="chat-thinking-content">
          <MarkdownAnswer
            text={
              text ||
              (streaming
                ? paused
                  ? '等待恢复连接…'
                  : '正在生成思考内容…'
                : '本轮未提供可展示的思考内容。')
            }
          />
        </div>
      )}
    </section>
  );
}
