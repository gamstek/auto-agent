import { ArrowUpRight, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useInstruments } from '../../hooks/useInstruments';
import { Button } from '../Button/Button';
import { IconButton } from '../IconButton/IconButton';
import { InstrumentDetails } from '../InstrumentDetails/InstrumentDetails';
import { InstrumentIcon } from '../InstrumentIcon/InstrumentIcon';
import './InstrumentMonitor.css';

export function InstrumentMonitor({
  id,
  connected,
  open,
  instant,
  onClose,
  onClosed,
  onInspect,
  onConfigure,
}: {
  id: string;
  connected: boolean;
  open: boolean;
  instant: boolean;
  onClose: (animate: boolean) => void;
  onClosed: () => void;
  onInspect: (animate: boolean) => void;
  onConfigure: (animate: boolean) => void;
}) {
  const { devices, error, loading, refresh } = useInstruments(connected && open);
  return (
    <aside
      className="instrument-monitor"
      id={id}
      aria-label="仪器实时状态"
      data-instant={instant}
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      onTransitionEnd={(event) => {
        if (!open && event.target === event.currentTarget && event.propertyName === 'transform')
          onClosed();
      }}
    >
      <header className="instrument-monitor-heading">
        <h2>
          <InstrumentIcon size={17} />
          仪器状态
        </h2>
        <div>
          <IconButton label="刷新仪器状态" disabled={loading || !connected} onClick={refresh}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </IconButton>
          <IconButton label="收起仪器状态" onClick={(event) => onClose(event.detail > 0)}>
            <X size={16} />
          </IconButton>
        </div>
      </header>
      <div className="instrument-monitor-body">
        {!connected && (
          <p className="instrument-monitor-notice" role="status">
            状态连接中断，恢复连接后重新读取。
          </p>
        )}
        {error && (
          <p className="instrument-monitor-notice" role="status">
            {error}
          </p>
        )}
        {!devices.length && (
          <div className="instrument-monitor-empty">
            {loading ? <LoaderCircle size={24} className="spin" /> : <InstrumentIcon size={28} />}
            <strong>
              {loading
                ? '正在读取仪器状态…'
                : connected && !error
                  ? '尚未配置仪器'
                  : '暂未取得仪器状态'}
            </strong>
            <p>
              {connected && !error && !loading
                ? '配置仪器后，可在这里查看连接与任务状态。'
                : '仅显示厂家实际返回的状态。'}
            </p>
            {connected && !error && !loading && (
              <Button variant="subtle" onClick={(event) => onConfigure(event.detail > 0)}>
                配置仪器
              </Button>
            )}
          </div>
        )}
        {devices.map((device) => (
          <article
            className="instrument-monitor-device"
            aria-label={device.name}
            key={device.deviceId}
          >
            <header>
              <h3>{device.name}</h3>
              <span className="instrument-monitor-freshness" data-stale={device.stale}>
                {device.stale ? '最后已知状态' : device.health.simulation ? '模拟状态' : '当前状态'}
              </span>
            </header>
            {device.stale && device.health.simulation && (
              <p className="instrument-monitor-simulation">模拟状态</p>
            )}
            <InstrumentDetails device={device} compact />
            <p className="instrument-monitor-updated">
              最后成功更新 ·{' '}
              {device.observedAt
                ? new Date(device.observedAt).toLocaleTimeString('zh-CN', { hour12: false })
                : '尚无成功查询'}
            </p>
          </article>
        ))}
      </div>
      <footer>
        <span>{!connected ? '等待恢复连接' : loading ? '正在更新…' : '自动更新'}</span>
        <Button
          variant="ghost"
          disabled={!connected}
          onClick={(event) => onInspect(event.detail > 0)}
        >
          查看详情
          <ArrowUpRight size={14} />
        </Button>
      </footer>
    </aside>
  );
}
