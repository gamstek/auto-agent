import type { ChatSnapshot } from '@auto-agent/desktop-protocol';

const stable = <T>(previous: T | undefined, next: T): T =>
  previous !== undefined && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

/** Keep unchanged native parts referentially stable so a token doesn't re-render every old Markdown block. */
export function reconcileChatSnapshot(
  previous: ChatSnapshot | null,
  next: ChatSnapshot,
): ChatSnapshot {
  if (!previous || previous.sessionId !== next.sessionId) return next;
  if (previous.revision > next.revision) return previous;
  const messages = new Map(previous.conversation.messages.map((message) => [message.id, message]));
  return {
    ...next,
    calls: stable(previous.calls, next.calls),
    turnDetails: stable(previous.turnDetails, next.turnDetails),
    conversation: {
      ...next.conversation,
      messages: next.conversation.messages.map((message) =>
        stable(messages.get(message.id), message),
      ),
      turns: stable(previous.conversation.turns, next.conversation.turns),
      inputs: stable(previous.conversation.inputs, next.conversation.inputs),
      tasks: stable(previous.conversation.tasks, next.conversation.tasks),
      agents: stable(previous.conversation.agents, next.conversation.agents),
    },
  };
}
