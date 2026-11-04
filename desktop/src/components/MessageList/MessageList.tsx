import type { ComponentPropsWithRef } from 'react';
import './MessageList.css';

export function MessageList({ children, className = '', ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div {...props} className={`conversation ${className}`}>
      <div className="conversation-inner">{children}</div>
    </div>
  );
}
