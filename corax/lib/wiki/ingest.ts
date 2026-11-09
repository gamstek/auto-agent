import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { generateText, wrapLanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { discoverText, type IngestModel, type IngestResult } from '@auto-agent/llm-wiki';
import type { AppConfig } from '../config/schema';
import { openLlmWiki, referenceSource } from './index';
import { modelErrorMiddleware } from '../model';

export interface KnowledgeProgress {
  phase: 'discovering' | 'checking' | 'analysis' | 'generation' | 'publishing';
  total: number;
  completed: number;
  source?: string;
}
export interface KnowledgeReport {
  status: 'completed' | 'failed' | 'cancelled';
  completed: IngestResult[];
  message?: string;
  failedSource?: string;
  sourceReference?: { id: string; sha256: string };
  ignored: string[];
  ignoredCount: number;
  ignoredTruncated: boolean;
  note?: string;
}
export const wikiModelIdentity = (config: AppConfig) =>
  createHash('sha256')
    .update(JSON.stringify([config.model, config.baseURL, config.maxOutputTokens]))
    .digest('hex');

export function discoverKnowledge(
  config: AppConfig,
  sourceId: string | undefined,
  signal: AbortSignal,
) {
  const selected = config.llmWiki.sources.filter((source) => !sourceId || source.id === sourceId);
  if (!selected.length) throw new Error('没有匹配的文本来源，请先添加资料');
  const root = process.env.AUTO_AGENT_PROJECT_ROOT ?? process.cwd();
  return discoverText(selected, signal, [
    join(config.dataDir, 'llm-wiki'),
    join(config.dataDir, 'corax'),
    ...referenceSource(root).protectedPaths,
  ]);
}

/** Explicit knowledge compilation, not another chat/Agent loop. No tools or automatic retries. */
export async function ingestLlmWiki(
  config: AppConfig,
  sourceId: string | undefined,
  signal: AbortSignal,
  progress: (value: KnowledgeProgress) => void = () => {},
): Promise<KnowledgeReport> {
  progress({ phase: 'discovering', total: 0, completed: 0 });
  const { documents, ignored, ignoredCount, ignoredTruncated } = await discoverKnowledge(
    config,
    sourceId,
    signal,
  );
  const completed: IngestResult[] = [];
  let source: string | undefined;
  const reportProgress = (phase: KnowledgeProgress['phase']) =>
    progress({
      phase,
      total: documents.length,
      completed: completed.length,
      source,
    });
  if (!documents.length)
    return {
      status: 'completed',
      completed: [],
      ignored,
      ignoredCount,
      ignoredTruncated,
      note: '没有可摄入的纯文本，未调用模型。',
    };
  const key = process.env.AUTO_AGENT_API_KEY;
  const provider = createOpenAICompatible({
    name: 'llm-wiki',
    baseURL: config.baseURL,
    apiKey: key,
  });
  const maxPromptBytes = (config.maxInputTokens - config.maxOutputTokens - 4096) * 2;
  if (maxPromptBytes < 8192) throw new Error('模型输入容量不足以执行 LLM Wiki 摄入');
  const model: IngestModel = {
    label: config.model,
    identity: wikiModelIdentity(config),
    maxPromptBytes,
    async complete({ stage, system, prompt, signal }) {
      reportProgress(stage);
      if (Buffer.byteLength(system + prompt) > maxPromptBytes)
        throw new Error('摄入上下文超出当前输入预算，请拆分资料或提升容量');
      const result = await generateText({
        model: wrapLanguageModel({
          model: provider.chatModel(config.model),
          middleware: modelErrorMiddleware,
        }),
        system,
        prompt,
        maxOutputTokens: config.maxOutputTokens,
        maxRetries: 0,
        abortSignal: signal,
      });
      if (['length', 'error', 'content-filter'].includes(result.finishReason))
        throw new Error('模型输出未完整成功结束，未发布本次知识变更');
      if (stage === 'generation') reportProgress('publishing');
      return result.text;
    },
  };
  const wiki = openLlmWiki(config);
  for (const document of documents) {
    source = document.name;
    reportProgress('checking');
    try {
      completed.push(await wiki.ingest(document, model, signal));
    } catch (error) {
      const detail = error instanceof Error ? error.message : '摄入失败';
      const message = key ? detail.replaceAll(key, '[redacted]') : detail;
      return {
        status: signal.aborted ? 'cancelled' : 'failed',
        completed,
        failedSource: document.name,
        sourceReference: { id: document.id, sha256: document.sha256 },
        message,
        ignored,
        ignoredCount,
        ignoredTruncated,
        note: '已完成来源已经发布；失败来源未发布，未自动重试。',
      };
    }
  }
  return { status: 'completed', completed, ignored, ignoredCount, ignoredTruncated };
}
