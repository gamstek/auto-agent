import { z } from 'zod';

export const textSourceSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
    type: z.enum(['file', 'directory']),
    path: z.string().min(1).max(4096),
  })
  .strict()
  .refine(
    (source) => source.type !== 'file' || /\.(md|markdown|txt)$/i.test(source.path),
    '只允许 Markdown/TXT 文本文件',
  );
export type TextSource = z.output<typeof textSourceSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.string().uuid();
export const sourceReferenceSchema = z.object({ id: digest, sha256: digest }).strict();
export const pageReferenceSchema = z
  .object({ generation, path: z.string().min(1).max(512), sha256: digest })
  .strict();
export type PageReference = z.output<typeof pageReferenceSchema>;
export type SourceReference = z.output<typeof sourceReferenceSchema>;
export const llmWikiInput = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('catalog'),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(30),
    })
    .strict(),
  z
    .object({
      action: z.literal('search'),
      query: z.string().trim().max(1000),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  z
    .object({
      action: z.literal('read'),
      reference: pageReferenceSchema,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(60),
      maxBytes: z.number().int().min(1024).max(262144).default(32768),
    })
    .strict(),
  z
    .object({
      action: z.literal('source'),
      generation,
      reference: sourceReferenceSchema,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(60),
      maxBytes: z.number().int().min(1024).max(262144).default(32768),
    })
    .strict(),
  z
    .object({
      action: z.literal('resolve'),
      issueId: digest,
      note: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
export const generatedPagesSchema = z
  .object({
    pages: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            title: z.string().trim().min(1).max(200),
            type: z.enum(['source', 'entity', 'concept', 'topic']),
            summary: z.string().trim().min(1).max(500),
            body: z.string().trim().min(1).max(64000),
            sources: z.array(sourceReferenceSchema).min(1).max(100),
            related: z.array(z.string().min(1).max(240)).max(50).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    issues: z.array(z.string().max(2000)).max(30).default([]),
  })
  .strict();
export type GeneratedPage = z.output<typeof generatedPagesSchema>['pages'][number];
export interface PageMetadata {
  title: string;
  type: string;
  summary: string;
  sha256: string;
  createdAt: string;
  updatedAt: string;
  sources: SourceReference[];
  related: string[];
}
export interface SourceMetadata {
  id: string;
  name: string;
  sha256: string;
  rawPath: string;
  pipelineHash: string;
  pipelineVersion: string;
  model: string;
  ingestedAt: string;
  pages: string[];
}
export interface Manifest {
  format: 1;
  generation: string;
  createdAt: string;
  issues: string[];
  sources: Record<string, SourceMetadata>;
  pages: Record<string, PageMetadata>;
}
export interface TextDocument {
  id: string;
  name: string;
  text: string;
  sha256: string;
}
export interface CompletionRequest {
  stage: 'analysis' | 'generation';
  system: string;
  prompt: string;
  signal: AbortSignal;
}
export interface IngestModel {
  identity: string;
  label?: string;
  maxPromptBytes: number;
  complete(request: CompletionRequest): Promise<string>;
}
