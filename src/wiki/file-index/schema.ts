import { z } from 'zod';

export const INDEX_REVISION = 'wiki-templates-v1';
export const MAX_FILES = 5000;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const warning =
  'Historical configuration evidence, not current execution state or scientific approval. Use the SAM skill profiles/create workflow to generate an independent new template from complete packaged configuration and task settings. Preserve product, version, units and source hashes.';
export const filtersSchema = z
  .object({
    material: z.string().trim().min(1).max(128).optional(),
    product: z.enum(['g5', 'g12', 's60pro']).optional(),
    gas: z.string().trim().min(1).max(128).optional(),
    analysisType: z.string().trim().min(1).max(128).optional(),
    pressureMode: z.enum(['relative-pp0', 'absolute-mmHg']).optional(),
    clientVersion: z.string().min(1).max(128).optional(),
    temperatureMinK: z.number().nonnegative().optional(),
    temperatureMaxK: z.number().nonnegative().optional(),
    kind: z.literal('sam').optional(),
    state: z.enum(['parsed', 'partial', 'unsupported', 'error']).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.temperatureMinK === undefined ||
      v.temperatureMaxK === undefined ||
      v.temperatureMinK <= v.temperatureMaxK,
    'Invalid temperature range',
  );
export const searchSchema = z
  .object({
    query: z.string().trim().max(1000).default(''),
    filters: filtersSchema.default({}),
    limit: z.number().int().min(1).max(10).default(3),
  })
  .strict();
export const readSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    query: z.string().trim().max(1000).default(''),
    maxEvidence: z.number().int().min(1).max(12).default(4),
  })
  .strict();
export const metadataSchema = z.object({
  materialHint: z.string(),
  materialBasis: z.literal('directory-hint'),
  product: z.string().nullable(),
  productBasis: z.enum(['status-family', 'unknown']),
  gas: z.string().nullable(),
  analysisType: z.string().nullable(),
  pressureMode: z.string().nullable(),
  clientVersion: z.string().nullable(),
  temperatureK: z.number().nullable(),
  fileState: z.string().nullable(),
  sampleName: z.string().nullable(),
  uuid: z.string().nullable(),
});
export const evidenceSchema = z.object({
  kind: z.literal('json-path'),
  text: z.string().max(1000),
  path: z.array(z.union([z.string(), z.number()])).optional(),
});
export const originSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (path) => !/^(?:[\\/]|[a-z]:)/i.test(path) && !path.split(/[\\/]/).includes('..'),
      'Origin path must be relative',
    ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  kind: z.literal('sam'),
  indexedAt: z.number().finite(),
  sourceVerified: z.literal(false),
});
export const recordSchema = z.object({
  id: z.string(),
  rootId: z.string(),
  path: z.string(),
  sha256: z.string().nullable(),
  bytes: z.number(),
  kind: z.literal('sam'),
  state: z.enum(['parsed', 'partial', 'unsupported', 'error']),
  metadata: metadataSchema,
  issues: z.array(z.string()),
  evidence: z.array(evidenceSchema),
  configuration: z.record(z.string(), z.unknown()).nullable(),
  origin: originSchema.optional(),
});
export type IndexedSource = z.infer<typeof recordSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export const summarySchema = recordSchema.omit({ evidence: true, configuration: true });
export const searchResultSchema = z.object({
  indexedAt: z.number(),
  results: z.array(summarySchema.extend({ sourceVerified: z.literal(false) })).max(10),
  matchedRecords: z.number(),
  truncated: z.boolean(),
  warning: z.string(),
});
export const readResultSchema = z.object({
  indexedAt: z.number(),
  record: recordSchema,
  sourceVerified: z.boolean(),
  evidenceTruncated: z.boolean(),
  warning: z.string(),
});
