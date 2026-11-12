import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { CoraxMessage } from '@auto-agent/desktop-protocol';

const PAGE_SIZE = 20;

/** A render window over the official projection, independent of write admission. */
export function useMessageWindow(
  key: string,
  messages: readonly CoraxMessage[],
  scroll: RefObject<HTMLDivElement | null>,
  stick: RefObject<boolean>,
  active: boolean,
) {
  const [window, setWindow] = useState<{ key: string; firstId?: string }>({ key });
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<{
    key: string;
    anchor: HTMLElement | null;
    top: number;
    height: number;
  } | null>(null);
  const remembered =
    window.key === key && window.firstId
      ? messages.findIndex((message) => message.id === window.firstId)
      : -1;
  const start = remembered >= 0 ? remembered : Math.max(0, messages.length - PAGE_SIZE);
  const latest = useRef({ key, messages, start, active });
  latest.current = { key, messages, start, active };
  useLayoutEffect(() => {
    pending.current = null;
    setWindow((previous) => (previous.key === key ? previous : { key }));
  }, [key]);
  const loadMore = useCallback(() => {
    const current = latest.current;
    const element = scroll.current;
    if (!current.active || !current.start || !element || pending.current) return;
    const anchor = element.querySelector<HTMLElement>('[data-message-id]');
    pending.current = {
      key: current.key,
      anchor,
      top: anchor?.getBoundingClientRect().top ?? 0,
      height: element.scrollHeight,
    };
    stick.current = false;
    setWindow({
      key: current.key,
      firstId: current.messages[Math.max(0, current.start - PAGE_SIZE)]!.id,
    });
  }, [scroll, stick]);
  const pin = useCallback(() => {
    const current = latest.current;
    if (!current.active || !current.messages[current.start]) return;
    setWindow((previous) =>
      previous.key === current.key && previous.firstId
        ? previous
        : { key: current.key, firstId: current.messages[current.start]!.id },
    );
  }, []);
  useLayoutEffect(() => {
    const previous = pending.current;
    pending.current = null;
    const element = scroll.current;
    if (!previous || previous.key !== key || !element) return;
    element.scrollTop += previous.anchor?.isConnected
      ? previous.anchor.getBoundingClientRect().top - previous.top
      : element.scrollHeight - previous.height;
  }, [key, active, messages[start]?.id, scroll]);
  useEffect(() => {
    if (!active || start === 0) return;
    let observer: IntersectionObserver | undefined;
    // Attach after the selected view's initial scroll-to-latest has settled.
    const frame = requestAnimationFrame(() => {
      if (!scroll.current || !trigger.current) return;
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) loadMore();
        },
        { root: scroll.current, rootMargin: '160px 0px 0px', threshold: 0 },
      );
      observer.observe(trigger.current);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [key, active, start, scroll, loadMore]);
  return { messages: messages.slice(start), hasMore: start > 0, trigger, loadMore, pin };
}
