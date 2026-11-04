export interface TranscriptRun {
  id: string;
  status: string;
}

export interface RunTranscriptEntry {
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

export interface RunTranscript {
  run: TranscriptRun;
  entries: RunTranscriptEntry[];
}

export interface RecordedToolDetail {
  input?: unknown;
  result?: {
    status: string;
    effect: string;
    output: unknown;
    modelText?: string;
  };
}

export function transcriptStatus(status: string, runStatus: string): string {
  if (status !== 'running' || runStatus === 'running') return status;
  return runStatus === 'cancelled' ? 'cancelled' : 'interrupted';
}
