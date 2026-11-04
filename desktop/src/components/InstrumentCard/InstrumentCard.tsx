import type { InstrumentSnapshot } from '../../types/instrument';
import { InstrumentDetails } from '../InstrumentDetails/InstrumentDetails';
import './InstrumentCard.css';

export function InstrumentCard({ device }: { device: InstrumentSnapshot }) {
  return (
    <article className="instrument-card" aria-label={device.name}>
      <header>
        <h2>{device.name}</h2>
        <span className={`instrument-freshness ${device.stale ? 'is-stale' : ''}`}>
          {device.health.simulation ? '模拟状态' : device.stale ? '状态待更新' : '当前状态'}
        </span>
      </header>
      <InstrumentDetails device={device} />
    </article>
  );
}
