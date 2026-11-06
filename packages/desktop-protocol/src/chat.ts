import type {
  ConversationState,
  CoraxMessage,
  InputResponse,
  ToolCallStatus,
} from '@coraxjs/core/client';
export type {
  ConversationState,
  CoraxMessage,
  CoraxMessagePart,
  CoraxDynamicToolPart,
  ConversationInput,
  InputResponse,
} from '@coraxjs/core/client';

/** One cursor-consistent projection of Corax's durable stream, never a second history store. */
export interface ChatSnapshot {
  sessionId: string;
  revision: number;
  conversation: ConversationState;
  /** Resolved in the frontend before cloning the official reducer's private projection. */
  calls: Readonly<Record<string, ChatCallState>>;
  turnDetails: Readonly<Record<string, ChatTurnDetails>>;
  busy: boolean;
  /** Active/admitted conversation turn; background tasks may remain busy between turns. */
  turnActive: boolean;
  waiting: boolean;
  closed: boolean;
  error?: string;
  connectionError?: string;
}

/** Display metadata projected from native event timestamps; not a separate execution record. */
export interface ChatTurnDetails {
  startedAt: number;
  endedAt?: number;
  compactions: readonly { id: string; stepIndex: number }[];
}

export interface ChatCallState {
  status: ToolCallStatus;
  errorText?: string;
  errorCode?: string;
}

export function messageText(message: CoraxMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

export interface ChatResponse {
  responses: readonly InputResponse[];
}
