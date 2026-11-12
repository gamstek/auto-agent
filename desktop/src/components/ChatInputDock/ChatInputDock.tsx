import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ConversationInput, InputResponse } from '@auto-agent/desktop-protocol';
import { ChatInputRequest } from '../ChatInputRequest/ChatInputRequest';
import { IconButton } from '../IconButton/IconButton';
import type { ChatInputAction } from '../../lib/chat-inputs';
import './ChatInputDock.css';

/** Only a presentation selector; requests and their lifecycle belong to Corax. */
export function ChatInputDock({
  inputs,
  disabled,
  onRespond,
  onSubmitState,
  onHeightChange,
}: {
  inputs: readonly ConversationInput[];
  disabled: boolean;
  onRespond: (response: InputResponse) => Promise<void>;
  onSubmitState: (action: ChatInputAction | null) => void;
  onHeightChange: (height: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string>();
  const index = Math.max(
    0,
    inputs.findIndex((input) => input.request.requestId === selected),
  );
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height) + 10);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => {
      observer.disconnect();
      onHeightChange(0);
    };
  }, [onHeightChange]);
  if (!inputs.length) return null;
  return (
    <div className="chat-input-dock" ref={root} aria-label="待处理交互">
      {inputs.length > 1 && (
        <nav className="chat-input-pagination" aria-label="切换待处理请求">
          <span>
            {index + 1} / {inputs.length} 项待处理
          </span>
          <IconButton
            label="上一个请求"
            disabled={index === 0}
            onClick={() => setSelected(inputs[index - 1]!.request.requestId)}
          >
            <ChevronLeft size={15} />
          </IconButton>
          <IconButton
            label="下一个请求"
            disabled={index === inputs.length - 1}
            onClick={() => setSelected(inputs[index + 1]!.request.requestId)}
          >
            <ChevronRight size={15} />
          </IconButton>
        </nav>
      )}
      {inputs.map((input, position) => (
        <div key={input.request.requestId} hidden={position !== index}>
          <ChatInputRequest
            input={input}
            disabled={disabled}
            onRespond={onRespond}
            onSubmitState={position === index ? onSubmitState : undefined}
          />
        </div>
      ))}
    </div>
  );
}
