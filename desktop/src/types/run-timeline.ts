export interface RunTimelineEntry {
  entryId: string;
  kind: 'model' | 'tool';
  name: string;
  status: string;
  step: number | null;
  text: string;
  reasoning: string;
  metadata: Record<string, unknown>;
  hasDetail: boolean;
}

export interface RunTimelineData {
  run: { id: string; status: string };
  entries: RunTimelineEntry[];
}

export interface ToolCallDetail {
  input?: unknown;
  result?: {
    status: string;
    effect: string;
    output: unknown;
    modelText?: string;
  };
}
