import { defineAgent, defineDynamic } from '@coraxjs/core';
import { defaultSettingsMiddleware } from 'ai';
import { getRuntimeConfig } from './lib/config';
import { createConfiguredModel } from './lib/model/client';
import { chatErrorMiddleware } from './lib/model/errors';

const config = getRuntimeConfig();

function model() {
  return {
    model: createConfiguredModel(
      config,
      'auto-agent',
      defaultSettingsMiddleware({
        settings: { maxOutputTokens: config.maxOutputTokens },
      }),
      chatErrorMiddleware,
    ),
    modelContextWindowTokens: config.maxInputTokens,
  };
}
export default defineAgent({
  model: defineDynamic({ events: { 'step.started': model } }),
  experimental: { workflow: { world: 'local' } },
});
