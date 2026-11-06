import { memo, useCallback, useState } from 'react';
import { ListCollapse } from 'lucide-react';
import type {
  CoraxMessage,
  ConversationState,
  ChatCallState,
  ChatTurnDetails,
  CoraxMessagePart,
} from '@auto-agent/desktop-protocol';
import { messageText } from '@auto-agent/desktop-protocol';
import { MarkdownAnswer } from '../MarkdownAnswer/MarkdownAnswer';
import { Avatar } from '../Avatar/Avatar';
import { ResponseActions } from '../ResponseActions/ResponseActions';
import { ChatThinking } from '../ChatThinking/ChatThinking';
import { ChatToolGroup } from '../ChatToolGroup/ChatToolGroup';
import { ChatProgress } from '../ChatProgress/ChatProgress';
import { ProcessingLabel } from '../ProcessingLabel/ProcessingLabel';
import { chatEntries } from '../../lib/chat-entries';
import { native } from '../../bridge';
import './ChatMessage.css';

export const ChatMessage = memo(
  function ChatMessage({
    message,
    conversation,
    callStates,
    details,
    sessionId,
    stopped = false,
    paused = false,
  }: {
    message: CoraxMessage;
    conversation: ConversationState;
    callStates: Readonly<Record<string, ChatCallState>>;
    details?: ChatTurnDetails;
    sessionId: string;
    stopped?: boolean;
    paused?: boolean;
  }) {
    const [linkError, setLinkError] = useState('');
    const [processExpanded, setProcessExpanded] = useState<boolean | null>(null);
    const [openCalls, setOpenCalls] = useState<ReadonlySet<string>>(() => new Set());
    const toggleCall = useCallback((id: string, open: boolean) => {
      if (open) setProcessExpanded(true);
      setOpenCalls((previous) => {
        if (previous.has(id) === open) return previous;
        const next = new Set(previous);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      });
    }, []);
    const turn = message.metadata?.turnId ? conversation.turns[message.metadata.turnId] : undefined;
    const terminal = stopped || (!!turn && turn.status !== 'active');
    const active = message.role === 'assistant' && !terminal && turn?.status === 'active';
    const showProcess = details ? (processExpanded ?? active) : true;
    const complete = message.metadata?.status === 'complete' || terminal;
    const text = messageText(message);
    const textParts = message.parts.flatMap((part, index) =>
      part.type === 'text' ? [{ part, index }] : [],
    );
    const lastText = textParts.at(-1);
    const finalText = new Set(
      complete && lastText
        ? textParts
            .filter(({ part, index }) =>
              lastText.part.stepIndex === undefined
                ? index === lastText.index
                : part.stepIndex === lastText.part.stepIndex,
            )
            .map(({ index }) => index)
        : [],
    );
    const hasProcess =
      message.parts.some((part) =>
        ['reasoning', 'dynamic-tool', 'authorization'].includes(part.type),
      ) ||
      textParts.length > 1 ||
      !!details?.compactions.length;
    const liveParts = message.parts.some(
      (part) =>
        ((part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming') ||
        (part.type === 'dynamic-tool' &&
          ['running', 'awaiting-input'].includes(callStates[part.toolCallId]!.status)),
    );
    const waiting =
      turn?.waiting ||
      Object.values(conversation.inputs).some(
        (input) => input.turnId === message.metadata?.turnId && input.status === 'open',
      );
    const entries = chatEntries(message.parts, details?.compactions ?? []);

    function renderPart(part: Exclude<CoraxMessagePart, { type: 'dynamic-tool' }>) {
      switch (part.type) {
        case 'text':
          return message.role === 'user' ? (
            <div className="user-text">{part.text}</div>
          ) : (
            <div data-streaming={part.state === 'streaming' && !terminal}>
              <MarkdownAnswer text={part.text} />
            </div>
          );
        case 'reasoning':
          return (
            <ChatThinking
              text={part.text}
              streaming={part.state === 'streaming' && !terminal}
              paused={paused}
              onOpen={() => setProcessExpanded(true)}
            />
          );
        case 'authorization':
          return (
            <div className="chat-authorization">
              <strong>{part.displayName}</strong>
              <p>{part.description}</p>
              {part.state === 'required' ? (
                <>
                  <p>{part.authorization?.instructions}</p>
                  {part.authorization?.url && (
                    <a
                      href={part.authorization.url}
                      onClick={(event) => {
                        event.preventDefault();
                        void native('open_link', { url: part.authorization!.url }).catch(() =>
                          setLinkError('无法打开授权页面，请检查系统默认浏览器。'),
                        );
                      }}
                    >
                      打开授权页面
                    </a>
                  )}
                  <code>{part.authorization?.userCode}</code>
                  <p>等待完成授权</p>
                </>
              ) : (
                <p>{part.reason ?? part.outcome}</p>
              )}
            </div>
          );
        case 'file':
          return <div className="chat-file">附件：{part.filename ?? part.mediaType}</div>;
        case 'step-start':
          return null;
      }
    }

    return (
      <div className={`message ${message.role} corax-message`} data-message-id={message.id}>
        {message.role === 'assistant' && <Avatar />}
        <div
          className={message.role === 'assistant' ? 'chat-output' : 'bubble'}
          data-process-open={showProcess}
        >
          {message.role === 'assistant' && details && (
            <ChatProgress
              details={details}
              active={active}
              paused={paused}
              status={turn?.status}
              expandable={hasProcess}
              expanded={showProcess}
              onToggle={() => setProcessExpanded(!showProcess)}
            />
          )}
          {entries.map((entry) => {
            if (entry.kind === 'tools')
              return (
                <div
                  key={`tools:${entry.parts[0]!.toolCallId}`}
                  className="chat-entry"
                  hidden={!showProcess}
                >
                  <ChatToolGroup
                    parts={entry.parts}
                    conversation={conversation}
                    calls={callStates}
                    openCalls={openCalls}
                    onToggleCall={toggleCall}
                    paused={paused}
                  />
                </div>
              );
            if (entry.kind === 'compaction')
              return (
                <div key={entry.id} className="chat-entry chat-compaction" hidden={!showProcess}>
                  <ListCollapse size={14} />
                  上下文已自动压缩
                </div>
              );
            const { part, index } = entry;
            const answer = message.role === 'assistant' && finalText.has(index);
            const visible =
              message.role === 'user' ||
              !hasProcess ||
              showProcess ||
              answer ||
              part.type === 'file' ||
              (part.type === 'authorization' && part.state === 'required');
            return (
              <div
                key={'id' in part && part.id ? part.id : `${part.type}:${index}`}
                className={`chat-entry${answer ? ' chat-answer-part' : ''}`}
                hidden={!visible}
              >
                {renderPart(part)}
              </div>
            );
          })}
          {active && !paused && !waiting && (!liveParts || (hasProcess && !showProcess)) && (
            <div className="chat-processing" role="status">
              <ProcessingLabel text="正在处理" />
            </div>
          )}
          {linkError && <p role="alert">{linkError}</p>}
          {message.role === 'assistant' && complete && text && (
            <ResponseActions
              message={{
                id: `${sessionId}:${message.id}`,
                content: finalText.size
                  ? textParts
                      .filter(({ index }) => finalText.has(index))
                      .map(({ part }) => part.text)
                      .join('\n\n')
                  : text,
              }}
            />
          )}
        </div>
      </div>
    );
  },
  (previous, next) =>
    previous.message === next.message &&
    previous.sessionId === next.sessionId &&
    previous.stopped === next.stopped &&
    previous.paused === next.paused &&
    previous.callStates === next.callStates &&
    previous.details === next.details &&
    previous.conversation.turns === next.conversation.turns &&
    previous.conversation.tasks === next.conversation.tasks &&
    previous.conversation.agents === next.conversation.agents &&
    previous.conversation.inputs === next.conversation.inputs,
);
