import { z } from 'zod';
import { completed, defineTool } from '../context';
import { knowledgeSchema, revision } from '../../wiki/knowledge';
import { filtersSchema, searchResultSchema, readResultSchema } from '../../wiki/file-index';

export const wikiTool = defineTool({
  description:
    'Read-only Wiki for a currently loaded skill. query returns compiled recommendations; search filters historical SAM/SMP template settings; read returns one ID with parameters and source-field citations. Bundled SQLite provides recorded historical settings and source hashes. Index maintenance is operator-only.',
  effects: ['read'],
  requiresLoadedSkill: true,
  // Providers require a JSON Schema object root. The pipe retains strict
  // per-action runtime validation without publishing a top-level anyOf.
  inputSchema: z
    .object({
      skill: z.string().min(1),
      action: z
        .enum(['query', 'search', 'read'])
        .default('query')
        .describe('query requires query text; search accepts filters; read requires id.'),
      query: z
        .string()
        .trim()
        .max(1000)
        .optional()
        .describe('Required for query; optional search text or read focus.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('query/search only. Defaults: query=5, search=3.'),
      filters: filtersSchema.optional().describe('search only; all supplied conditions apply.'),
      id: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe('read only; use an ID returned by search.'),
      maxEvidence: z.number().int().min(1).max(12).optional().describe('read only; defaults to 4.'),
    })
    .strict()
    .pipe(
      z.union([
        z
          .object({
            skill: z.string().min(1),
            action: z.literal('query'),
            query: z.string().min(1).max(1000),
            limit: z.number().int().min(1).max(10).default(5),
          })
          .strict(),
        z
          .object({
            skill: z.string().min(1),
            action: z.literal('search'),
            query: z.string().trim().max(1000).default(''),
            filters: filtersSchema.default({}),
            limit: z.number().int().min(1).max(10).default(3),
          })
          .strict(),
        z
          .object({
            skill: z.string().min(1),
            action: z.literal('read'),
            id: z.string().regex(/^[a-f0-9]{64}$/),
            query: z.string().trim().max(1000).default(''),
            maxEvidence: z.number().int().min(1).max(12).default(4),
          })
          .strict(),
      ]),
    ),
  outputSchema: z.union([
    z.object({
      builtAt: z.number(),
      revision: z.literal(revision),
      results: z
        .array(
          knowledgeSchema.shape.records.element.extend({
            source: z.string(),
            sourceHash: z.string(),
            sourceIssues: z.array(z.string()),
            score: z.number(),
            match: z.unknown(),
          }),
        )
        .max(10),
      truncated: z.boolean(),
      indexedRecords: z.number().int().nonnegative(),
      matchedRecords: z.number().int().nonnegative(),
      queryTruncated: z.boolean(),
      mode: z.literal('keyword'),
      status: z.enum(['recommendations_only', 'output_limit', 'no_match']),
      availableTerms: z.array(z.string()).optional(),
      hint: z.string().optional(),
      warning: z.string(),
    }),
    searchResultSchema,
    readResultSchema,
  ]),
  retention: { kind: 'evidence' },
  async execute(input, { wiki, run }) {
    if (input.action === 'search')
      return completed(
        wiki.search({ query: input.query, filters: input.filters, limit: input.limit }),
      );
    if (input.action === 'read')
      return completed(
        await wiki.read(
          { id: input.id, query: input.query, maxEvidence: input.maxEvidence },
          run.signal,
        ),
      );
    return completed(await wiki.query(input.query, input.limit));
  },
});
