import type { ComponentPropsWithRef } from 'react';
import './Input.css';

export function Input({ className = '', ...props }: ComponentPropsWithRef<'input'>) {
  return <input {...props} className={`ui-input ${className}`} />;
}
