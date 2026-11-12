/** Version of the application bridge, independent of Corax's release/stream version. */
export const DESKTOP_PROTOCOL_VERSION = 4;
export * from './chat';
export type { ApprovalMode, ApprovalSetting, DesktopApprovalSetting } from './approval';
export type { InstrumentSnapshot } from './instrument';
export type { QuestionSuggestions } from './suggestions';
export type {
  KnowledgeReference,
  KnowledgeOperation,
  KnowledgeOperationState,
  KnowledgeSourceState,
  KnowledgePageEntry,
  KnowledgeSnapshot,
  KnowledgePage,
} from './knowledge';

/** Features callable through the application bridge; absence means unavailable. */
export interface BackendCapabilities {
  devices?: { list?: boolean };
  sessions?: {
    create?: boolean;
    send?: boolean;
    history?: boolean;
    /** Structured Corax conversation projection: parts, turns, inputs, tasks and child sessions. */
    conversation?: boolean;
    cancel?: boolean;
    clear?: boolean;
    compact?: boolean;
    reset?: boolean;
  };
  messages?: {
    text?: boolean;
    /** The history API can return reasoning if the model emitted it. */
    reasoning?: boolean;
    /** Structured tool-call rendering is available through the conversation API. */
    toolCalls?: boolean;
  };
  events?: {
    /** Live notifications; reconnecting does not replay writes. */
    notifications?: boolean;
    /** Corax's bounded durable event snapshot can be read. */
    snapshot?: boolean;
    /** Native event batches update text, thinking, actions and conversation state. */
    conversationUpdates?: boolean;
  };
  interaction?: { respond?: boolean };
}

export interface BackendHealth {
  healthy: boolean;
  version: string;
  protocolVersion: number;
  engine: string;
  capabilities: BackendCapabilities;
}

export const coraxCapabilities = {
  devices: { list: true },
  sessions: {
    create: true,
    send: true,
    history: true,
    conversation: true,
    cancel: true,
    clear: true,
    compact: true,
    reset: true,
  },
  messages: { text: true, reasoning: true, toolCalls: true },
  events: { notifications: true, snapshot: true, conversationUpdates: true },
  interaction: { respond: true },
} as const satisfies BackendCapabilities;
