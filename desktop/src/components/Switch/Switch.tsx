import type { ComponentPropsWithRef } from 'react';
import './Switch.css';

export function Switch({
  className = '',
  ...props
}: Omit<ComponentPropsWithRef<'input'>, 'type' | 'role'>) {
  return <input {...props} type="checkbox" role="switch" className={`ui-switch ${className}`} />;
}
