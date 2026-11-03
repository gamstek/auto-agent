import type { RefObject } from 'react';
import { ArrowUp, ChevronsDown, LoaderCircle, Square } from 'lucide-react';

export function Composer({
  input,
  onInput,
  inputRef,
  onSend,
  onCancel,
  busy,
  sending,
  connected,
  pendingReview,
  showBottom,
  onBottom,
}: {
  input: string;
  onInput: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onSend: () => void;
  onCancel: () => void;
  busy: boolean;
  sending: boolean;
  connected: boolean;
  pendingReview: boolean;
  showBottom: boolean;
  onBottom: () => void;
}) {
  return (
    <div className="composer-region">
      {showBottom && (
        <button className="back-to-bottom" onClick={onBottom}>
          <ChevronsDown size={16} />
          回到最新消息
        </button>
      )}
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          disabled={pendingReview}
          placeholder={pendingReview ? '请先完成上方执行对账' : '询问量仔，或描述你的测样需求…'}
          aria-label="输入消息"
          onChange={(event) => onInput(event.target.value)}
          onInput={(event) => {
            event.currentTarget.style.height = 'auto';
            event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 140)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        {busy ? (
          <button
            type="button"
            className="send-button stop"
            title="取消本次回复，不代表仪器停止"
            aria-label="取消本次回复"
            onClick={onCancel}
          >
            <Square size={16} fill="currentColor" />
          </button>
        ) : (
          <button
            className="send-button"
            aria-label="发送消息"
            disabled={!input.trim() || sending || !connected || pendingReview}
          >
            {sending ? <LoaderCircle className="spin" size={19} /> : <ArrowUp size={22} />}
          </button>
        )}
      </form>
    </div>
  );
}
