export interface KnowledgeReference {
  generation: string;
  path: string;
  sha256: string;
}
export interface KnowledgeOperation {
  id: string;
  state: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
  phase: 'discovering' | 'checking' | 'analysis' | 'generation' | 'publishing';
  total: number;
  completed: number;
  source?: string;
  reused: number;
  pageCount: number;
  message?: string;
  failedSource?: string;
  startedAt: string;
  finishedAt?: string;
}
export interface KnowledgeOperationState {
  generation: string;
  configRevision: string | null;
  operation: KnowledgeOperation | null;
  admissionUncertain?: boolean;
}
export interface KnowledgeSourceState {
  id: string;
  status: 'pending' | 'ready' | 'changed' | 'error' | 'empty';
  documents: number;
  ready: number;
  pageCount: number;
  ingestedAt?: string;
  message?: string;
}
export interface KnowledgePageEntry {
  path: string;
  title: string;
  type: string;
  summary: string;
  reference: KnowledgeReference;
  /** Explicit published links, not inferred semantic similarities. */
  related?: string[];
  relatedCount?: number;
  relatedTruncated?: boolean;
  sourceCount?: number;
  updatedAt?: string;
}
export interface KnowledgeSnapshot extends KnowledgeOperationState {
  published: boolean;
  publication?: string;
  pageCount: number;
  wikiDirectory?: string;
  sources: KnowledgeSourceState[];
  pages: KnowledgePageEntry[];
  nextOffset: number | null;
}
export interface KnowledgePage {
  reference: KnowledgeReference;
  title: string;
  text: string;
  startLine: number;
  endLine: number;
  nextOffset: number | null;
}
