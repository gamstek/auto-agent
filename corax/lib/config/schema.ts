import { z } from 'zod';
import { textSourceSchema } from '@auto-agent/llm-wiki/contracts';

export const climberSchema = z
  .object({
    enabled: z.boolean().default(true),
    serviceURL: z.string().max(4096).default('http://127.0.0.1:18080/api/v1'),
    timeoutMs: z.number().int().min(100).max(60000).default(5000),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.enabled && !value.serviceURL) return;
    try {
      const url = new URL(value.serviceURL);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/api\/v1\/?$/.test(url.pathname)
      )
        throw new Error('Invalid URL');
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['serviceURL'],
        message: 'Climber 地址须为不含凭据、查询参数或片段的 HTTP(S) /api/v1 地址。',
      });
    }
  });

export const configSchema = z
  .object({
    dataDir: z.string().min(1).default('.'),
    model: z.string().trim().min(1).max(200).default('deepseek-flash'),
    baseURL: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, 'Expected an HTTP(S) provider URL without credentials, query or fragment')
      .default('https://api.deepseek.com'),
    maxInputTokens: z.number().int().positive().default(128000),
    maxOutputTokens: z.number().int().positive().default(16000),
    systemPrompt: z.string().max(16000).default(''),
    approvalMode: z.enum(['always', 'once', 'never']).default('always'),
    climber: climberSchema.prefault({}),
    llmWiki: z
      .object({
        sources: z.array(textSourceSchema).max(100).default([]),
      })
      .strict()
      .superRefine((wiki, context) => {
        const ids = new Set<string>();
        for (const [index, entry] of wiki.sources.entries()) {
          if (ids.has(entry.id))
            context.addIssue({
              code: 'custom',
              message: 'IDs must be unique',
              path: ['sources', index, 'id'],
            });
          ids.add(entry.id);
        }
      })
      .default({ sources: [] }),
  })
  .strict();

export type AppConfig = z.output<typeof configSchema>;
