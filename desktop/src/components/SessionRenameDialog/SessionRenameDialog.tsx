import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle } from 'lucide-react';
import type { Session } from '../../bridge';
import { errorText } from '../../bridge';
import { Button } from '../Button/Button';
import { Input } from '../Input/Input';
import './SessionRenameDialog.css';

export function SessionRenameDialog({
  session,
  onSave,
  onClose,
}: {
  session: Session;
  onSave: (id: string, title: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(session.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const id = useId();
  const value = title.trim();
  const length = Array.from(value).length;
  const valid = length > 0 && length <= 100 && !/[\x00-\x1f\x7f]/u.test(title);
  useLayoutEffect(() => {
    dialog.current?.showModal();
    input.current?.focus();
    input.current?.select();
    return () => dialog.current?.close();
  }, []);

  return createPortal(
    <dialog
      ref={dialog}
      className="session-rename-dialog"
      aria-labelledby={`${id}-heading`}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked.current) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (locked.current || !valid || value === session.title) return;
          locked.current = true;
          setSaving(true);
          setError('');
          try {
            await onSave(session.id, value);
            onClose();
          } catch (cause) {
            setError(errorText(cause));
          } finally {
            locked.current = false;
            setSaving(false);
          }
        }}
      >
        <h2 id={`${id}-heading`}>重命名会话</h2>
        <label htmlFor={`${id}-title`}>会话名称</label>
        <Input
          ref={input}
          id={`${id}-title`}
          value={title}
          disabled={saving}
          autoComplete="off"
          aria-describedby={`${id}-hint`}
          aria-invalid={!valid || !!error}
          onChange={(event) => {
            setTitle(event.target.value);
            setError('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
          }}
        />
        <div id={`${id}-hint`} className="session-rename-hint">
          <span>{length > 100 ? '名称不能超过 100 个字符' : '使用简短的名称，方便以后查找'}</span>
          <span>{length}/100</span>
        </div>
        {error && (
          <p className="session-rename-error" role="alert">
            {error}
          </p>
        )}
        <div className="session-rename-actions">
          <Button type="button" variant="subtle" disabled={saving} onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={saving || !valid || value === session.title}
          >
            {saving && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
            {saving ? '正在保存…' : '保存'}
          </Button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}
