import type { ComponentPropsWithRef } from 'react';
import './Textarea.css';

export function Textarea({ className = '', ...props }: ComponentPropsWithRef<'textarea'>) {
  return <textarea {...props} className={`ui-textarea ${className}`} />;
}
