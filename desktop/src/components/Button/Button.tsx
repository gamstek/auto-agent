import type { ComponentPropsWithRef } from 'react';
import './Button.css';

type ButtonProps = ComponentPropsWithRef<'button'>;
export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ButtonProps & {
  variant?: 'primary' | 'secondary' | 'subtle' | 'ghost' | 'danger';
}) {
  return (
    <button {...props} type={type} className={`ui-button ${className}`} data-variant={variant} />
  );
}
