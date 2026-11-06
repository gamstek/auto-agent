import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronsDown, LoaderCircle, Square } from 'lucide-react';
import { SendIcon } from '../SendIcon/SendIcon';
import './Composer.css';

export function Composer({
  input,
  onInput,
  inputRef,
  onSend,
  onCancel,
  busy,
  sending,
  connected,
  waitingForInput,
  canCancel = true,
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
  waitingForInput: boolean;
  canCancel?: boolean;
  showBottom: boolean;
  onBottom: () => void;
}) {
  const textareaId = useId();
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; scroll: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [scrollbar, setScrollbar] = useState({
    visible: false,
    height: 0,
    top: 0,
    maximum: 0,
    value: 0,
  });
  const syncScroll = useCallback(() => {
    const area = inputRef.current;
    if (!area) return;
    const maximum = Math.max(0, area.scrollHeight - area.clientHeight);
    const trackHeight = Math.max(0, area.clientHeight - 8);
    const height = Math.min(
      trackHeight,
      Math.max(24, (trackHeight * area.clientHeight) / Math.max(1, area.scrollHeight)),
    );
    const next = {
      visible: maximum > 1,
      height,
      top: maximum ? ((trackHeight - height) * area.scrollTop) / maximum : 0,
      maximum,
      value: area.scrollTop,
    };
    setScrollbar((previous) =>
      JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
    );
  }, [inputRef]);
  const resize = useCallback(() => {
    const area = inputRef.current;
    if (!area) return;
    const previousScroll = area.scrollTop;
    area.style.height = 'auto';
    area.style.height = `${Math.max(48, Math.min(area.scrollHeight, 144))}px`;
    const form = area.closest('.composer');
    const context = document.createElement('canvas').getContext('2d');
    if (form && context) {
      const style = getComputedStyle(area);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const reserve =
        parseFloat(getComputedStyle(form).getPropertyValue('--composer-inline-reserve')) || 105;
      setExpanded(
        area.value.includes('\n') ||
          context.measureText(area.value).width > Math.max(1, form.clientWidth - reserve),
      );
    }
    area.scrollTop = previousScroll;
    syncScroll();
  }, [inputRef, syncScroll]);
  useLayoutEffect(() => {
    resize();
  }, [input, resize]);
  useLayoutEffect(() => {
    const area = inputRef.current;
    if (!area) return;
    let width = area.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width !== area.clientWidth) {
        width = area.clientWidth;
        resize();
      } else syncScroll();
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [inputRef, resize, syncScroll]);
  const moveScroll = (value: number) => {
    const area = inputRef.current;
    if (area) {
      area.scrollTop = Math.max(0, Math.min(scrollbar.maximum, value));
      syncScroll();
    }
  };
  return (
    <div className="composer-region">
      {showBottom && (
        <button className="back-to-bottom" onClick={onBottom}>
          <ChevronsDown size={16} />
          回到最新消息
        </button>
      )}
      <form
        className={`composer ${expanded ? 'is-expanded' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div className="composer-editor">
          <textarea
            id={textareaId}
            ref={inputRef}
            rows={1}
            value={input}
            disabled={waitingForInput}
            placeholder={
              waitingForInput ? '请先回答上方问题或确认调用' : '询问量仔，或描述你的测样需求…'
            }
            aria-label="输入消息"
            onChange={(event) => onInput(event.target.value)}
            onInput={resize}
            onScroll={syncScroll}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          {scrollbar.visible && (
            <div
              className="composer-scrollbar"
              ref={track}
              role="scrollbar"
              aria-label="输入框滚动条"
              aria-controls={textareaId}
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={Math.round(scrollbar.maximum)}
              aria-valuenow={Math.round(scrollbar.value)}
              tabIndex={0}
              onPointerDown={(event) => {
                if (event.button !== 0 || event.target !== event.currentTarget) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                moveScroll(
                  ((event.clientY - rect.top - scrollbar.height / 2) /
                    Math.max(1, rect.height - scrollbar.height)) *
                    scrollbar.maximum,
                );
              }}
              onKeyDown={(event) => {
                const amount =
                  event.key === 'ArrowDown'
                    ? 24
                    : event.key === 'ArrowUp'
                      ? -24
                      : event.key === 'PageDown'
                        ? 120
                        : event.key === 'PageUp'
                          ? -120
                          : 0;
                if (amount) {
                  event.preventDefault();
                  moveScroll(scrollbar.value + amount);
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault();
                  moveScroll(event.key === 'Home' ? 0 : scrollbar.maximum);
                }
              }}
            >
              <div
                className="composer-scroll-thumb"
                style={{ height: scrollbar.height, transform: `translateY(${scrollbar.top}px)` }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  drag.current = { y: event.clientY, scroll: inputRef.current?.scrollTop ?? 0 };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  if (drag.current && track.current)
                    moveScroll(
                      drag.current.scroll +
                        ((event.clientY - drag.current.y) /
                          Math.max(1, track.current.clientHeight - scrollbar.height)) *
                          scrollbar.maximum,
                    );
                }}
                onPointerUp={(event) => {
                  drag.current = null;
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
              />
            </div>
          )}
        </div>
        <div className="composer-actions">
          {busy ? (
            <button
              type="button"
              className="send-button stop"
              title="取消本次回复，不代表仪器停止"
              aria-label="取消本次回复"
              disabled={!canCancel}
              onClick={onCancel}
            >
              <Square size={16} fill="currentColor" />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="发送消息"
              disabled={!input.trim() || sending || !connected || waitingForInput}
            >
              {sending ? <LoaderCircle className="spin" size={19} /> : <SendIcon />}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
