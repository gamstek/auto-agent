import { z } from 'zod';
import { completed, defineTool } from '../context';
import { knowledgeSchema, revision } from '../../wiki/knowledge';

export const wikiTool = defineTool({
  description:
    'Query compiled local wiki recommendations with source-line citations for a loaded skill. Read-only; no instrument actions. Knowledge updates require explicit operator --wiki-update.',
  effects: ['read'],
  requiresLoadedSkill: true,
  inputSchema: z.object({
    skill: z.string().min(1),
    query: z.string().min(1).max(1000),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  outputSchema: z.object({
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
  retention: { kind: 'evidence' },
  async execute({ query, limit }, { wiki }) {
    return completed(await wiki.query(query, limit));
  },
});
