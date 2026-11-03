import type { ComponentPropsWithRef } from 'react';
import './Conversation.css';

export function Conversation({ children, className = '', ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div {...props} className={`conversation ${className}`}>
      <div className="conversation-inner">{children}</div>
    </div>
  );
}
