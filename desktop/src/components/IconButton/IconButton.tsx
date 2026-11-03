import type { ComponentPropsWithRef } from 'react';
import './IconButton.css';

export function IconButton({
  label,
  selected,
  variant = 'ghost',
  className = '',
  type = 'button',
  ...props
}: ComponentPropsWithRef<'button'> & {
  label: string;
  selected?: boolean;
  variant?: 'ghost' | 'rail';
}) {
  return (
    <button
      {...props}
      type={type}
      aria-label={label}
      title={props.title ?? label}
      aria-pressed={selected}
      data-selected={selected ?? false}
      data-variant={variant}
      className={`icon-button ui-icon ${className}`}
    />
  );
}
