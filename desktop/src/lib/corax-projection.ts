import { conversationReducer, toolCallState, type MessageStreamEvent } from '@coraxjs/core/client';
import type { ChatSnapshot, ChatCallState, ChatTurnDetails } from '@auto-agent/desktop-protocol';

/** In-memory UI projection of native events. No transport, credentials or history storage. */
export class CoraxProjection {
  private state = conversationReducer.initial();
  private revision = 0;
  private closed = false;
  private error?: string;
  private connectionError?: string;
  private admitted = false;
  private turnDetails: Record<string, ChatTurnDetails> = Object.create(null);

  constructor(readonly id: string) {}

  get nextIndex() {
    return this.revision;
  }

  admission(value: boolean, revision: number) {
    if (revision >= this.revision) this.admitted = value;
  }

  reload(events: readonly MessageStreamEvent[], admitted: boolean) {
    this.state = conversationReducer.initial();
    this.revision = 0;
    this.closed = false;
    this.error = undefined;
    this.connectionError = undefined;
    this.turnDetails = Object.create(null);
    this.admitted = admitted;
    this.append(0, events);
    // Admission may be newer than all recorded events in this snapshot.
    this.admitted = admitted;
  }

  append(startIndex: number, events: readonly MessageStreamEvent[]) {
    if (startIndex > this.revision) throw new Error('Corax 事件游标不连续，正在重新读取会话。');
    for (const event of events.slice(Math.max(0, this.revision - startIndex))) {
      this.apply(event);
      this.revision++;
    }
    this.connectionError = undefined;
  }

  disconnected(message?: string) {
    this.connectionError = message;
  }
  unavailable(message: string) {
    this.closed = true;
    this.admitted = false;
    this.error = message;
    this.connectionError = undefined;
  }

  snapshot(): ChatSnapshot {
    const turns = Object.values(this.state.turns).filter((turn) => turn.status === 'active');
    const working = Object.values(this.state.tasks).some((task) =>
      Object.values(task.calls).some((call) => call.status === 'working'),
    );
    const waiting =
      turns.some((turn) => turn.waiting) ||
      Object.values(this.state.inputs).some((input) => input.status === 'open');
    const calls: Record<string, ChatCallState> = Object.create(null);
    for (const message of this.state.messages)
      for (const part of message.parts) {
        if (part.type !== 'dynamic-tool') continue;
        const call = toolCallState(this.state, part.toolCallId, {
          streaming: !this.closed && !this.connectionError,
        });
        if (!call) throw new Error(`Corax 缺少工具状态：${part.toolCallId}`);
        calls[part.toolCallId] = {
          status: call.status,
          ...(call.errorText ? { errorText: call.errorText } : {}),
          ...(call.errorCode ? { errorCode: call.errorCode } : {}),
        };
      }
    return {
      sessionId: this.id,
      revision: this.revision,
      conversation: this.state,
      calls,
      turnDetails: this.turnDetails,
      busy: !this.closed && (this.admitted || turns.length > 0 || working),
      turnActive: !this.closed && (this.admitted || turns.length > 0),
      waiting: !this.closed && waiting,
      closed: this.closed,
      error: this.error,
      connectionError: this.connectionError,
    };
  }

  private apply(event: MessageStreamEvent) {
    this.state = conversationReducer.reduce(this.state, event);
    const at = Date.parse(event.meta.at);
    if (Number.isFinite(at)) {
      if (event.type === 'turn.started')
        this.turnDetails = {
          ...this.turnDetails,
          [event.data.turnId]: { startedAt: at, compactions: [] },
        };
      else if (['turn.completed', 'turn.cancelled', 'turn.failed'].includes(event.type)) {
        const id = (event.data as { turnId: string }).turnId;
        const details = this.turnDetails[id];
        if (details) this.turnDetails = { ...this.turnDetails, [id]: { ...details, endedAt: at } };
      } else if (event.type === 'compaction.completed') {
        const details = this.turnDetails[event.data.turnId];
        if (details && details.endedAt === undefined)
          this.turnDetails = {
            ...this.turnDetails,
            [event.data.turnId]: {
              ...details,
              compactions: [
                ...details.compactions,
                { id: event.meta.id, stepIndex: event.data.stepIndex },
              ],
            },
          };
      } else if (event.type === 'session.failed' || event.type === 'session.completed') {
        this.turnDetails = Object.fromEntries(
          Object.entries(this.turnDetails).map(([id, details]) => [
            id,
            details.endedAt === undefined ? { ...details, endedAt: at } : details,
          ]),
        );
      }
    }
    if (
      [
        'turn.started',
        'message.received',
        'input.resolved',
        'session.completed',
        'session.failed',
      ].includes(event.type)
    )
      this.admitted = false;
    if (event.type === 'turn.started' || event.type === 'context.cleared') this.error = undefined;
    if (event.type === 'turn.failed' || event.type === 'session.failed') {
      const data = event.data as { message?: string; error?: { message?: string } };
      this.error = data.error?.message ?? data.message ?? 'Corax 执行失败';
    }
    if (event.type === 'session.completed' || event.type === 'session.failed') this.closed = true;
  }
}
