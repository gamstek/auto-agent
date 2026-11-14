import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil } from 'lucide-react';
import './SessionContextMenu.css';

export function SessionContextMenu({
  x,
  y,
  onRename,
  onClose,
}: {
  x: number;
  y: number;
  onRename: () => void;
  onClose: (restoreFocus?: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const element = menu.current!;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
    element.querySelector('button')?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!element.contains(event.target as Node)) onClose();
    };
    const dismiss = () => onClose();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [x, y, onClose]);

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label="会话操作"
      className="session-context-menu"
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'F2') {
          event.preventDefault();
          onRename();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        }
        if (event.key === 'Tab') onClose();
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) event.preventDefault();
      }}
    >
      <button type="button" role="menuitem" onClick={onRename}>
        <Pencil size={15} aria-hidden="true" />
        <span>重命名</span>
        <kbd>F2</kbd>
      </button>
    </div>,
    document.body,
  );
}
