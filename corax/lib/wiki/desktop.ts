import type { KnowledgeOperation, KnowledgeSourceState } from '@auto-agent/desktop-protocol';
import type { TextDocument } from '@auto-agent/llm-wiki';
import type { AppConfig } from '../config/schema';
import { openLlmWiki } from './index';
import {
  discoverKnowledge,
  wikiModelIdentity,
  type KnowledgeProgress,
  type KnowledgeReport,
} from './ingest';

const active = (value: KnowledgeOperation) =>
  value.state === 'running' || value.state === 'cancelling';
const bounded = (value: string, limit: number) => [...value].slice(0, limit).join('');
const message = (error: unknown) => {
  let value = error instanceof Error ? error.message : '知识整理失败';
  for (const secret of [process.env.AUTO_AGENT_API_KEY, process.env.AUTO_AGENT_TOKEN])
    if (secret) value = value.replaceAll(secret, '[redacted]');
  return bounded(value, 1600);
};

/** One process-local compiler operation. Publications remain owned by LLM Wiki. */
export class KnowledgeOperations {
  private current?: { value: KnowledgeOperation; controller: AbortController; done: Promise<void> };

  snapshot() {
    return this.current ? { ...this.current.value } : null;
  }

  start(
    id: string,
    run: (
      signal: AbortSignal,
      progress: (value: KnowledgeProgress) => void,
    ) => Promise<KnowledgeReport>,
  ) {
    if (this.current?.value.id === id) return this.current;
    if (this.current && active(this.current.value)) throw new Error('已有知识整理正在执行');
    const controller = new AbortController();
    const value: KnowledgeOperation = {
      id,
      state: 'running',
      phase: 'discovering',
      total: 0,
      completed: 0,
      reused: 0,
      pageCount: 0,
      startedAt: new Date().toISOString(),
    };
    const current = { value, controller, done: Promise.resolve() };
    this.current = current;
    current.done = Promise.resolve().then(async () => {
      try {
        const result = await run(controller.signal, (progress) => {
          Object.assign(value, progress, {
            source: progress.source ? bounded(progress.source, 240) : undefined,
          });
        });
        value.state = result.status;
        value.completed = result.completed.length;
        value.reused = result.completed.filter((entry) => entry.reused).length;
        value.pageCount = new Set(result.completed.flatMap((entry) => entry.pages)).size;
        value.message = result.message ? bounded(result.message, 1600) : result.note;
        value.failedSource = result.failedSource ? bounded(result.failedSource, 240) : undefined;
      } catch (error) {
        value.state = controller.signal.aborted ? 'cancelled' : 'failed';
        value.message = message(error);
      } finally {
        value.finishedAt = new Date().toISOString();
      }
    });
    return current;
  }

  cancel(id: string) {
    if (!this.current || this.current.value.id !== id)
      throw new Error('整理记录已变化，请刷新状态');
    if (active(this.current.value)) {
      this.current.value.state = 'cancelling';
      this.current.controller.abort();
    }
    return this.snapshot();
  }
}

export const knowledgeOperations = new KnowledgeOperations();

/** Inspect configured inputs and existing publications without calling models or creating a Wiki. */
export async function knowledgeSnapshot(config: AppConfig) {
  // A compilation may finish during this read. Keep the initial operation
  // state so a client which saw it running still polls for the final snapshot.
  const operation = knowledgeOperations.snapshot();
  const wiki = openLlmWiki(config);
  const sources: KnowledgeSourceState[] = [];
  const identity = wikiModelIdentity(config);
  type Source = Pick<TextDocument, 'id' | 'name' | 'sha256'>;
  const discoveredSources = new Map<string, Source[]>();
  for (const source of config.llmWiki.sources) {
    try {
      const discovered = await discoverKnowledge(config, source.id, new AbortController().signal);
      discoveredSources.set(
        source.id,
        discovered.documents.map(({ id, name, sha256 }) => ({ id, name, sha256 })),
      );
    } catch (error) {
      sources.push({
        id: source.id,
        status: 'error',
        documents: 0,
        ready: 0,
        pageCount: 0,
        message: message(error),
      });
    }
  }
  const base = await wiki.inspectSources([...discoveredSources.values()].flat(), identity);
  const inspected = new Map(base.sources.map((source) => [source.id, source]));
  for (const source of config.llmWiki.sources) {
    const discovered = discoveredSources.get(source.id);
    if (discovered) {
      const documents = discovered.map((document) => inspected.get(document.id)!);
      const ready = documents.filter((entry) => entry.status === 'ready').length;
      const error = documents.find((entry) => entry.status === 'error');
      sources.push({
        id: source.id,
        documents: documents.length,
        ready,
        pageCount: documents.reduce((count, entry) => count + entry.pageCount, 0),
        status: error
          ? 'error'
          : !documents.length
            ? 'empty'
            : ready === documents.length
              ? 'ready'
              : documents.some((entry) => entry.status === 'changed')
                ? 'changed'
                : 'pending',
        ingestedAt: documents
          .map((entry) => entry.ingestedAt)
          .filter((value): value is string => !!value)
          .sort()
          .at(-1),
        message:
          error?.message ?? (!documents.length ? '没有可整理的 Markdown/TXT 文件' : undefined),
      });
    }
  }
  const catalog = base.generation
    ? await wiki.catalog(0, 20, base.generation)
    : { pages: [], nextOffset: null };
  return {
    published: base.published,
    publication: base.generation,
    pageCount: base.pageCount,
    wikiDirectory: base.wikiDirectory,
    sources,
    pages: catalog.pages,
    nextOffset: catalog.nextOffset,
    operation,
  };
}
