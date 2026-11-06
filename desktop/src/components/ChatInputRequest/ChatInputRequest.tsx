import { useState } from 'react';
import type { ConversationInput, InputResponse } from '@auto-agent/desktop-protocol';
import { Button } from '../Button/Button';
import { Textarea } from '../Textarea/Textarea';
import './ChatInputRequest.css';

export function ChatInputRequest({
  input,
  disabled,
  onRespond,
}: {
  input: ConversationInput;
  disabled: boolean;
  onRespond: (response: InputResponse) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const request = input.request;
  async function respond(response: InputResponse) {
    if (sending || submitted || disabled) return;
    setSending(true);
    setError('');
    try {
      await onRespond(response);
      setSubmitted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }
  const freeform =
    request.allowFreeform === true || (request.allowFreeform !== false && !request.options?.length);
  return (
    <section
      className="chat-input-request"
      aria-label={request.kind === 'tool-approval' ? '工具审批' : '需要你的回答'}
    >
      <strong>{request.kind === 'tool-approval' ? '需要确认' : '需要你的回答'}</strong>
      <p>{request.prompt}</p>
      <div className="chat-input-options">
        {request.options?.map((option) => (
          <Button
            key={option.id}
            variant={option.style === 'primary' ? 'primary' : 'ghost'}
            disabled={disabled || sending || submitted}
            title={option.description}
            onClick={() => void respond({ requestId: request.requestId, optionId: option.id })}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {freeform && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) void respond({ requestId: request.requestId, text: text.trim() });
          }}
        >
          <Textarea
            aria-label="回答内容"
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={disabled || sending || submitted}
          />
          <Button type="submit" disabled={disabled || sending || submitted || !text.trim()}>
            提交回答
          </Button>
        </form>
      )}
      {submitted && <p role="status">回答已提交，等待继续执行。</p>}
      {error && <p role="alert">{error}。请刷新状态确认是否已受理，再决定是否重新提交。</p>}
    </section>
  );
}
