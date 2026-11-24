import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, ChevronDown, Copy, File, Folder, FolderOpen } from 'lucide-react';
import { errorText, native } from '../../bridge';
import type { LocalFile } from '../../lib/local-files';
import '../SessionContextMenu/SessionContextMenu.css';
import './LocalFileLink.css';

export function LocalFileLink({ file }: { file: LocalFile }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const element = menu.current;
    const rect = element.getBoundingClientRect();
    const point = pointer.current ?? { x: anchor.left, y: anchor.bottom };
    const edge = 8;
    const left = point.x + rect.width <= window.innerWidth - edge ? point.x : point.x - rect.width;
    const top =
      point.y + rect.height <= window.innerHeight - edge ? point.y : point.y - rect.height;
    setPosition({
      left: Math.max(edge, Math.min(left, window.innerWidth - rect.width - edge)),
      top: Math.max(edge, Math.min(top, window.innerHeight - rect.height - edge)),
    });
    element.querySelector('button')?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !element.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close();
    };
    const dismiss = () => close();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [open, close]);

  async function run(action: 'open' | 'reveal' | 'copy') {
    close(true);
    setFeedback(undefined);
    try {
      if (action === 'copy') {
        await navigator.clipboard.writeText(file.path);
      } else await native('local_file_action', { path: file.path, action });
    } catch (error) {
      setFeedback({ text: errorText(error), error: true });
    }
  }

  const Icon = file.kind === 'directory' ? Folder : File;
  return (
    <span className="local-file-link">
      <button
        ref={trigger}
        type="button"
        className="local-file-trigger"
        title={file.path}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          pointer.current = event.detail > 0 ? { x: event.clientX, y: event.clientY } : null;
          setFeedback(undefined);
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            pointer.current = null;
            setOpen(true);
          }
        }}
      >
        <Icon size={15} aria-hidden="true" />
        <span>{file.label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {feedback && (
        <span className="local-file-feedback" role={feedback.error ? 'alert' : 'status'}>
          {feedback.text}
        </span>
      )}
      {open &&
        createPortal(
          <div
            id={id}
            role="menu"
            aria-label={`${file.label} 的操作`}
            ref={menu}
            className="session-context-menu local-file-menu"
            style={position}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(true);
                return;
              }
              if (event.key === 'Tab') {
                close(true);
                return;
              }
              if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
              const items = Array.from(event.currentTarget.querySelectorAll('button'));
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              const index =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
              event.preventDefault();
              items[index]?.focus({ preventScroll: true });
            }}
          >
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => void run('open')}>
              <ArrowUpRight size={15} aria-hidden="true" />
              {file.kind === 'directory' ? '打开目录' : file.kind === 'file' ? '打开文件' : '打开'}
            </button>
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => void run('reveal')}>
              <FolderOpen size={15} aria-hidden="true" />
              在文件管理器中显示
            </button>
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => void run('copy')}>
              <Copy size={15} aria-hidden="true" />
              复制路径
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}
