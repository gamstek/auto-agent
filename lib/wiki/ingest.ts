import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { discoverText, type IngestModel } from '@auto-agent/llm-wiki';
import type { AppConfig } from '../config/schema';
import { openLlmWiki, referenceSource } from './index';

/** Explicit knowledge compilation, not another chat/Agent loop. No tools or automatic retries. */
export async function ingestLlmWiki(
  config: AppConfig,
  sourceId: string | undefined,
  signal: AbortSignal,
) {
  const selected = config.llmWiki.sources.filter((source) => !sourceId || source.id === sourceId);
  if (!selected.length) throw new Error('没有匹配的纯文本来源，请先配置 llmWiki.sources');
  const root = process.env.AUTO_AGENT_PROJECT_ROOT ?? process.cwd();
  const { documents, ignored, ignoredCount, ignoredTruncated } = await discoverText(
    selected,
    signal,
    [
      join(config.dataDir, 'llm-wiki'),
      join(config.dataDir, 'corax'),
      ...referenceSource(root).protectedPaths,
    ],
  );
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
  if (!key?.trim())
    throw new Error('摄入会调用模型，需要 AUTO_AGENT_API_KEY；桌面会使用已配置的系统凭据');
  const provider = createOpenAICompatible({
    name: 'llm-wiki',
    baseURL: config.baseURL,
    apiKey: key,
  });
  const maxPromptBytes = (config.maxInputTokens - config.maxOutputTokens - 4096) * 2;
  if (maxPromptBytes < 8192) throw new Error('模型输入容量不足以执行 LLM Wiki 摄入');
  const model: IngestModel = {
    label: config.model,
    identity: createHash('sha256')
      .update(JSON.stringify([config.model, config.baseURL, config.maxOutputTokens]))
      .digest('hex'),
    maxPromptBytes,
    async complete({ system, prompt, signal }) {
      if (Buffer.byteLength(system + prompt) > maxPromptBytes)
        throw new Error('摄入上下文超出当前输入预算，请拆分资料或提升容量');
      const result = await generateText({
        model: provider.chatModel(config.model),
        system,
        prompt,
        maxOutputTokens: config.maxOutputTokens,
        maxRetries: 0,
        abortSignal: signal,
      });
      if (['length', 'error', 'content-filter'].includes(result.finishReason))
        throw new Error('模型输出未完整成功结束，未发布本次知识变更');
      return result.text;
    },
  };
  const wiki = openLlmWiki(config);
  const completed: unknown[] = [];
  for (const document of documents) {
    try {
      completed.push(await wiki.ingest(document, model, signal));
    } catch (error) {
      const message = (error instanceof Error ? error.message : '摄入失败').replaceAll(
        key,
        '[redacted]',
      );
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
