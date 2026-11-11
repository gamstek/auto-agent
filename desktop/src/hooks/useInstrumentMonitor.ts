import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

/** Display preference only: instrument facts still come from the native read-only snapshots. */
export function useInstrumentMonitor(container: RefObject<HTMLElement | null>, available: boolean) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [wide, setWide] = useState(false);
  const [preference, setPreference] = useState<boolean | null>(null);
  const [instant, setInstant] = useState(false);
  const [exiting, setExiting] = useState(false);
  useLayoutEffect(() => {
    const element = container.current;
    if (!available || !element) return;
    const measure = () => setWide(element.clientWidth >= 1200);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [container, available]);
  const open = available && (preference ?? wide);
  useEffect(() => {
    if (!exiting) return;
    // Media changes or interrupted transitions may not deliver transitionend.
    const timer = setTimeout(() => setExiting(false), 240);
    return () => clearTimeout(timer);
  }, [exiting]);
  const close = useCallback(
    (animate: boolean) => {
      const immediate = !animate || matchMedia('(prefers-reduced-motion: reduce)').matches;
      setInstant(immediate);
      setExiting(open && !immediate);
      setPreference(false);
      trigger.current?.focus({ preventScroll: true });
    },
    [open],
  );
  const finishExit = useCallback(() => setExiting(false), []);
  return {
    id,
    trigger,
    open,
    present: available && (open || exiting),
    instant,
    toggle: (animate: boolean) => {
      if (open) {
        close(animate);
        return;
      }
      setInstant(!animate || matchMedia('(prefers-reduced-motion: reduce)').matches);
      setExiting(false);
      setPreference(true);
    },
    close,
    finishExit,
  };
}
