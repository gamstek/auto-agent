import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Copy, Square, Minus, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import { desktop, errorText, native } from './bridge';
import { IconButton } from './components/ui';

export function Titlebar({
  sidebar,
  onToggleSidebar,
  onError,
  onWindowState,
}: {
  sidebar: boolean;
  onToggleSidebar: (animate: boolean) => void;
  onError: (message: string) => void;
  onWindowState: (maximized: boolean) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  async function action(action: string) {
    try {
      const value = await native<{ maximized: boolean }>('window_action', { action });
      if (value) {
        setMaximized(value.maximized);
        onWindowState(value.maximized);
      }
    } catch (error) {
      onError(errorText(error));
    }
  }
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void action('state');
    void listen('main-window-state', () => void action('state'))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) => onError(errorText(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return (
    <header className="titlebar" aria-label="应用标题栏">
      <span className="titlebar-brand" aria-hidden="true">
        Ai
      </span>
      <IconButton
        className="sidebar-toggle"
        title={sidebar ? '收起会话列表' : '展开会话列表'}
        label="切换会话列表"
        onClick={(event) => onToggleSidebar(event.detail > 0)}
      >
        {sidebar ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
      </IconButton>
      <div
        className="titlebar-drag"
        onMouseDown={(event) => {
          if (event.button === 0 && event.detail === 1) void action('drag');
        }}
        onDoubleClick={() => void action('toggle-maximize')}
      >
        <span>
          量仔 <span className="titlebar-separator">/</span> AI 工作空间
        </span>
      </div>
      <div className="window-controls">
        <button aria-label="最小化窗口" title="最小化" onClick={() => void action('minimize')}>
          <Minus size={14} strokeWidth={1.3} />
        </button>
        <button
          aria-label={maximized ? '还原窗口' : '最大化窗口'}
          title={maximized ? '还原' : '最大化'}
          onClick={() => void action('toggle-maximize')}
        >
          {maximized ? (
            <Copy size={11} strokeWidth={1.3} />
          ) : (
            <Square size={11} strokeWidth={1.3} />
          )}
        </button>
        <button
          className="window-close"
          aria-label="关闭窗口"
          title="关闭"
          onClick={() => void action('close')}
        >
          <X size={15} strokeWidth={1.4} />
        </button>
      </div>
    </header>
  );
}
