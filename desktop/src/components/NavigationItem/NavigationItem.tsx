import type { ComponentPropsWithRef, ReactNode } from 'react';
import './NavigationItem.css';

export function NavigationItem({
  selected,
  icon,
  label,
  trailing,
  className = '',
  ...props
}: Omit<ComponentPropsWithRef<'button'>, 'children'> & {
  selected: boolean;
  icon?: ReactNode;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <button
      {...props}
      type="button"
      className={`nav-item ${className}`}
      data-selected={selected}
      aria-current={selected ? 'page' : undefined}
    >
      {icon && <span className="nav-item-icon">{icon}</span>}
      <span className="nav-item-label">{label}</span>
      {trailing && <small className="nav-item-meta">{trailing}</small>}
    </button>
  );
}
