import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Shield, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { ApprovalMode } from '@auto-agent/desktop-protocol';
import { Button } from '../Button/Button';
import './ApprovalPolicy.css';

const policies = [
  {
    mode: 'always',
    label: '每次批准',
    description: '写入和命令执行前询问',
    icon: ShieldQuestion,
  },
  {
    mode: 'once',
    label: '每会话首次批准',
    description: '批准一次后，本会话同名工具不再询问',
    icon: ShieldCheck,
  },
  {
    mode: 'never',
    label: '无需批准',
    description: '工具执行不再询问批准',
    icon: Shield,
  },
] as const;

export function ApprovalPolicy({
  mode,
  disabled,
  loading,
  error,
  onChange,
  onRefresh,
}: {
  mode?: ApprovalMode;
  disabled: boolean;
  loading: boolean;
  error: string;
  onChange: (mode: ApprovalMode) => Promise<void>;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const selected = policies.find((policy) => policy.mode === mode);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', pointer);
    return () => document.removeEventListener('pointerdown', pointer);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  return (
    <div
      className="approval-policy"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        className="approval-policy-trigger"
        data-mode={mode}
        aria-label="审批策略"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={loading}
        title={disabled ? '审批策略正在同步' : '选择所有会话使用的原生审批策略'}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() =>
              items.current[event.key === 'ArrowDown' ? 0 : policies.length - 1]?.focus(),
            );
          }
        }}
      >
        <Shield size={14} />
        <span>{loading ? '正在同步策略' : (selected?.label ?? '策略待同步')}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="approval-policy-popup"
          id={id}
          role="menu"
          aria-label="选择审批策略"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
          }}
          onKeyDown={(event) => {
            const index = items.current.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              event.key === 'ArrowDown'
                ? (index + 1) % policies.length
                : event.key === 'ArrowUp'
                  ? (index + policies.length - 1) % policies.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? policies.length - 1
                      : undefined;
            if (next !== undefined) {
              event.preventDefault();
              items.current[next]?.focus();
            }
          }}
        >
          <p className="approval-policy-caption">如何批准工具操作？</p>
          {policies.map(({ mode: value, label, description, icon: Icon }, index) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={mode === value}
              aria-disabled={disabled || !mode}
              ref={(element) => {
                items.current[index] = element;
              }}
              onClick={() => {
                if (disabled || !mode) return;
                close();
                void onChange(value);
              }}
            >
              <Icon size={16} />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              {mode === value && <Check size={15} />}
            </button>
          ))}
          <p className="approval-policy-note">所有会话 · 当前运行生效</p>
          {error && (
            <div className="approval-policy-error" role="alert">
              {error}
              <Button variant="ghost" onClick={onRefresh}>
                重新读取策略
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
