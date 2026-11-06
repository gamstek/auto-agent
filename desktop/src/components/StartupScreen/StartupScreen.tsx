import { LoaderCircle } from 'lucide-react';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import { Titlebar } from '../Titlebar/Titlebar';
import './StartupScreen.css';

export function StartupScreen({
  busy,
  stage,
  error,
  canRetry,
  maximized,
  onRetry,
  onError,
  onWindowState,
}: {
  busy: boolean;
  stage: 'server' | 'workspace';
  error: string;
  canRetry: boolean;
  maximized: boolean;
  onRetry: () => void;
  onError: (message: string) => void;
  onWindowState: (maximized: boolean) => void;
}) {
  return (
    <div
      className={`app startup-shell ${maximized ? 'is-maximized' : ''}`}
      data-backend-state={busy ? 'starting' : 'disconnected'}
    >
      <Titlebar
        sidebar={false}
        showSidebarToggle={false}
        onToggleSidebar={() => {}}
        onError={onError}
        onWindowState={onWindowState}
      />
      <main className="startup-screen" aria-label="应用启动" aria-busy={busy}>
        <div className="startup-content">
          <Avatar />
          <h1>
            {busy ? (stage === 'server' ? '正在启动 Corax' : '正在加载工作空间') : '启动失败'}
          </h1>
          {busy && (
            <>
              <p>
                {stage === 'server' ? '本地服务就绪后，将自动进入工作空间。' : '正在读取会话列表。'}
              </p>
              <div className="startup-progress" role="status">
                <LoaderCircle className="spin" size={22} aria-hidden="true" />
                <span>请稍候…</span>
              </div>
            </>
          )}
          {error && (
            <p className="startup-error" role="alert">
              {error}
            </p>
          )}
          {!busy && (
            <Button variant="primary" disabled={!canRetry} onClick={onRetry}>
              重试启动
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}
