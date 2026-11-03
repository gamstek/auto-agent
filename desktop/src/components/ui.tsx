import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import './ui.css';

type ButtonProps = ComponentPropsWithRef<'button'>;
export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ButtonProps & { variant?: 'primary' | 'secondary' | 'subtle' | 'ghost' | 'danger' }) {
  return (
    <button {...props} type={type} className={`ui-button ${className}`} data-variant={variant} />
  );
}
export function IconButton({
  label,
  selected,
  variant = 'ghost',
  className = '',
  type = 'button',
  ...props
}: ButtonProps & { label: string; selected?: boolean; variant?: 'ghost' | 'rail' }) {
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
export function NavigationItem({
  selected,
  icon,
  label,
  trailing,
  className = '',
  ...props
}: Omit<ButtonProps, 'children'> & {
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
export function Input({ className = '', ...props }: ComponentPropsWithRef<'input'>) {
  return <input {...props} className={`ui-input ${className}`} />;
}
export function Textarea({ className = '', ...props }: ComponentPropsWithRef<'textarea'>) {
  return <textarea {...props} className={`ui-textarea ${className}`} />;
}
export function Switch({
  className = '',
  ...props
}: Omit<ComponentPropsWithRef<'input'>, 'type' | 'role'>) {
  return <input {...props} type="checkbox" role="switch" className={`ui-switch ${className}`} />;
}
export function SearchField({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (text: string) => void;
}) {
  return (
    <label className="ui-search">
      <Search size={15} />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <IconButton label={`清空${label}`} className="search-clear" onClick={() => onChange('')}>
          <X size={13} />
        </IconButton>
      )}
    </label>
  );
}
