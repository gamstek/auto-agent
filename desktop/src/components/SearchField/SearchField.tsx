import { Search, X } from 'lucide-react';
import { IconButton } from '../IconButton/IconButton';
import './SearchField.css';

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
