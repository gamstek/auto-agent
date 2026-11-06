import { RefreshCw } from 'lucide-react';
import { Button } from '../Button/Button';
import { InstrumentCard } from '../InstrumentCard/InstrumentCard';
import { InstrumentIcon } from '../InstrumentIcon/InstrumentIcon';
import { useInstruments } from '../../hooks/useInstruments';
import './Instruments.css';

export function Instruments({ onConfigure }: { onConfigure: () => void }) {
  const { devices, error, loading, refresh } = useInstruments();
  return (
    <section className="instruments-page" aria-label="仪器状态">
      <header className="instruments-heading">
        <div>
          <h1>仪器</h1>
          <p>查看设备连接和厂家返回的当前任务状态</p>
        </div>
        <Button disabled={loading} onClick={refresh}>
          <RefreshCw size={15} className={loading ? 'spin' : ''} />
          刷新状态
        </Button>
      </header>
      {error && (
        <p className="instruments-error" role="alert">
          {error}
        </p>
      )}
      {!devices.length && (
        <div className="instruments-empty">
          <InstrumentIcon size={28} />
          <h2>{loading ? '正在读取仪器配置…' : '尚未配置仪器'}</h2>
          <p>在“设置 → 仪器”中配置 Climber 厂家地址。</p>
        </div>
      )}
      {devices.map((device) => (
        <InstrumentCard key={device.deviceId} device={device} />
      ))}
      <Button variant="subtle" onClick={onConfigure}>
        配置仪器
      </Button>
    </section>
  );
}
