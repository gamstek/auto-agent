import { defineAgent, defineDynamic } from '@coraxjs/core';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';
import { getRuntimeConfig } from './lib/config';
import { modelErrorMiddleware } from './lib/model';

const config = getRuntimeConfig();

function model() {
  const provider = createOpenAICompatible({
    name: 'auto-agent',
    baseURL: config.baseURL,
    apiKey: process.env.AUTO_AGENT_API_KEY,
  });
  return {
    model: wrapLanguageModel({
      model: provider.chatModel(config.model),
      middleware: [
        modelErrorMiddleware,
        defaultSettingsMiddleware({
          settings: { maxOutputTokens: config.maxOutputTokens },
        }),
      ],
    }),
    modelContextWindowTokens: config.maxInputTokens,
  };
}
export default defineAgent({
  model: defineDynamic({ events: { 'step.started': model } }),
  experimental: { workflow: { world: 'local' } },
});
