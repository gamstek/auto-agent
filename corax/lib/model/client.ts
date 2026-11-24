import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import type { AppConfig } from '../config/schema';
import { modelErrorMiddleware } from './errors';

export function createConfiguredModel(
  config: Pick<AppConfig, 'baseURL' | 'model'>,
  name: string,
  middleware?: LanguageModelMiddleware,
) {
  const provider = createOpenAICompatible({
    name,
    baseURL: config.baseURL,
    apiKey: process.env.AUTO_AGENT_API_KEY,
  });
  return wrapLanguageModel({
    model: provider.chatModel(config.model),
    middleware: middleware ? [modelErrorMiddleware, middleware] : modelErrorMiddleware,
  });
}
