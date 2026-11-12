import { useId, useLayoutEffect, useState } from 'react';
import { Check, CircleHelp, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { ConversationInput, InputResponse } from '@auto-agent/desktop-protocol';
import { Button } from '../Button/Button';
import { Textarea } from '../Textarea/Textarea';
import { Input } from '../Input/Input';
import type { ChatInputAction } from '../../lib/chat-inputs';
import { errorText } from '../../bridge';
import './ChatInputRequest.css';

export function ChatInputRequest({
  input,
  disabled,
  onRespond,
  onSubmitState,
}: {
  input: ConversationInput;
  disabled: boolean;
  onRespond: (response: InputResponse) => Promise<void>;
  onSubmitState?: (action: ChatInputAction | null) => void;
}) {
  const formId = useId();
  const [text, setText] = useState('');
  const [optionId, setOptionId] = useState<string>();
  const [sending, setSending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const request = input.request;
  const approval = request.kind === 'tool-approval';
  const question = request.kind === 'question';
  const settled = input.status === 'settled';
  const responded = input.status === 'responded' || submitted;
  const locked = disabled || sending || responded || uncertain || settled;
  const freeform =
    !approval &&
    (request.allowFreeform === true ||
      (request.allowFreeform !== false && !request.options?.length));
  const outcome = input.outcome;
  const status = settled
    ? outcome === 'approved'
      ? '已批准'
      : outcome === 'denied'
        ? '已拒绝'
        : outcome === 'answered'
          ? '已回答'
          : outcome === 'cancelled'
            ? '已取消'
            : '已结束'
    : uncertain
      ? '结果待确认'
      : sending
        ? '正在提交'
        : responded
          ? '等待后端确认'
          : disabled
            ? '等待状态同步'
            : approval
              ? '等待批准'
              : '等待回答';
  const submitDisabled = locked || (optionId === undefined && (!freeform || !text.trim()));
  useLayoutEffect(() => {
    onSubmitState?.(
      question && !settled
        ? { requestId: request.requestId, formId, disabled: submitDisabled, submitting: sending }
        : null,
    );
  }, [onSubmitState, question, settled, request.requestId, formId, submitDisabled, sending]);
  async function respond(response: InputResponse) {
    if (locked) return;
    setSending(true);
    setError('');
    try {
      await onRespond(response);
      setSubmitted(true);
    } catch (cause) {
      const rejected =
        !!cause &&
        typeof cause === 'object' &&
        'admission' in cause &&
        cause.admission === 'rejected';
      setUncertain(!rejected);
      setError(errorText(cause));
    } finally {
      setSending(false);
    }
  }
  return (
    <section
      className="chat-input-request"
      data-kind={request.kind}
      data-request-id={request.requestId}
      data-settled={settled}
      aria-label={approval ? '工具审批' : '需要你的回答'}
    >
      <header className="chat-input-heading">
        <span className="chat-input-icon">
          {approval ? <ShieldCheck size={15} /> : <CircleHelp size={16} />}
        </span>
        <strong>{approval ? request.action.toolName : request.prompt}</strong>
        <span className="chat-input-status" role="status">
          {sending && <LoaderCircle size={12} className="spin" />}
          {status}
        </span>
      </header>
      <div className="chat-input-content">
        {approval && <p className="chat-input-prompt">{request.prompt}</p>}
        {approval && (
          <details className="chat-approval-details">
            <summary>查看本次调用参数</summary>
            <pre>{JSON.stringify(request.action.input, null, 2)}</pre>
          </details>
        )}
        {!settled && question && (
          <form
            id={formId}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (!submitDisabled) event.currentTarget.requestSubmit();
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              if (optionId !== undefined) void respond({ requestId: request.requestId, optionId });
              else if (freeform && text.trim())
                void respond({ requestId: request.requestId, text: text.trim() });
            }}
          >
            {!!request.options?.length && (
              <fieldset className="chat-question-options" disabled={locked}>
                <legend>选择一个选项</legend>
                {request.options.map((option, index) => (
                  <label
                    key={option.id}
                    className="chat-question-option"
                    data-selected={optionId === option.id}
                  >
                    <input
                      type="radio"
                      name={`question-${request.requestId}`}
                      checked={optionId === option.id}
                      onChange={() => {
                        setOptionId(option.id);
                        setText('');
                      }}
                    />
                    <span className="chat-option-number" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="chat-option-copy">
                      <strong>{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {optionId === option.id && <Check size={15} aria-hidden="true" />}
                  </label>
                ))}
              </fieldset>
            )}
            {freeform && (
              <label className="chat-question-freeform">
                <span>{request.options?.length ? '也可以自行填写' : '你的回答'}</span>
                <Input
                  aria-label="回答内容"
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    setOptionId(undefined);
                  }}
                  disabled={locked}
                  placeholder="输入自定义答案"
                />
              </label>
            )}
          </form>
        )}
        {!settled && !question && (
          <div className="chat-input-options">
            {request.options?.map((option) => (
              <Button
                key={option.id}
                variant={
                  option.style === 'primary'
                    ? 'primary'
                    : option.style === 'danger'
                      ? 'danger'
                      : 'secondary'
                }
                disabled={locked}
                title={option.description}
                onClick={() => void respond({ requestId: request.requestId, optionId: option.id })}
              >
                {approval && option.id === 'approve'
                  ? '批准本次'
                  : approval && ['cancel', 'deny'].includes(option.id)
                    ? '拒绝'
                    : option.label}
              </Button>
            ))}
          </div>
        )}
        {!settled && !question && freeform && (
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
              disabled={locked}
            />
            <div className="chat-input-actions">
              <Button type="submit" disabled={locked || !text.trim()}>
                提交回答
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p className="chat-input-error" role="alert">
            {error}
            {uncertain && '。响应结果尚未确认，请刷新会话状态核对；不会自动重复提交。'}
          </p>
        )}
      </div>
    </section>
  );
}
