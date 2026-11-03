import type { ReactNode } from 'react';
import './SettingsSection.css';

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-group" aria-label={title}>
      <h2>{title}</h2>
      <div className="setting-rows">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  control,
  id,
  wide = false,
}: {
  label: string;
  description?: string;
  control: ReactNode;
  id?: string;
  wide?: boolean;
}) {
  return (
    <div className={`setting-row ${wide ? 'wide-row' : ''}`}>
      <div className="setting-copy">
        {id ? <label htmlFor={id}>{label}</label> : <span className="setting-label">{label}</span>}
        {description && <p id={id ? `${id}-help` : undefined}>{description}</p>}
      </div>
      <div className="setting-control">{control}</div>
    </div>
  );
}
