import { AppError } from '../shared/types';
import { z } from 'zod';

export const revision = 'wiki-v1';
const citation = z.object({
  line: z.number().int().positive(),
  quote: z.string().min(1).max(4000),
});
const fact = z.object({
  value: z.string().min(1).max(4000),
  citations: z.array(citation).min(1).max(10),
});
export const knowledgeSchema = z.object({
  summary: z.string().max(2000),
  records: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        terms: z.array(z.string().min(1).max(100)).min(1).max(30),
        facts: z.record(z.string().min(1).max(100), fact),
        issues: z.array(z.string().min(1).max(1000)).max(30),
      }),
    )
    .max(300)
    .superRefine((records, context) => {
      const seen = new Set<string>();
      for (const [index, record] of records.entries()) {
        const identity = JSON.stringify([
          record.title.trim(),
          Object.entries(record.facts)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([field, fact]) => [
              field,
              fact.value,
              [...new Set(fact.citations.map((ref) => ref.line))].sort((a, b) => a - b),
            ]),
        ]);
        if (seen.has(identity)) {
          context.addIssue({
            code: 'custom',
            path: [index],
            message: 'Duplicate record with the same title, facts and source lines',
          });
        }
        seen.add(identity);
      }
    }),
  issues: z.array(z.string().min(1).max(1000)).max(100),
});
export type Knowledge = z.infer<typeof knowledgeSchema>;
const snapshotSources = z
  .array(z.object({ path: z.string(), hash: z.string(), knowledge: knowledgeSchema }))
  .max(100);
export const bundledSnapshotSchema = z.object({
  revision: z.literal(revision),
  builtAt: z.number(),
  sources: snapshotSources,
});
export const snapshotSchema = bundledSnapshotSchema.extend({ root: z.string() });
export type Snapshot = z.infer<typeof snapshotSchema>;
export interface Source {
  path: string;
  hash: string;
  text: string;
}

export function parseKnowledge(
  result: string,
  lines: string[],
  scope?: { start: number; end: number },
): Knowledge {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(result);
  let value: unknown;
  try {
    value = JSON.parse((fenced?.[1] ?? result).trim());
  } catch {
    throw new AppError(
      'wiki_generation',
      'Model output is not a complete JSON object (possibly fenced, truncated or surrounded by prose)',
    );
  }
  const parsed = knowledgeSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map(
        (issue) =>
          `${issue.path.join('.') || 'root'}: ${issue.code === 'custom' ? issue.message : issue.code}`,
      );
    throw new AppError(
      'wiki_generation',
      `Knowledge schema validation failed: ${issues.join('; ')}`,
    );
  }
  for (const [index, record] of parsed.data.records.entries()) {
    if (!Object.keys(record.facts).length)
      throw new AppError('wiki_generation', `records.${index}.facts: empty record`);
    if (
      scope &&
      !Object.values(record.facts).some((fact) =>
        fact.citations.some(
          (ref) => ref.line >= scope.start && ref.line <= scope.end && ref.quote.trim().length > 0,
        ),
      )
    ) {
      throw new AppError(
        'wiki_generation',
        `records.${index}: no source citation in extraction scope ${scope.start}–${scope.end}`,
      );
    }
    for (const [field, fact] of Object.entries(record.facts)) {
      for (const [refIndex, ref] of fact.citations.entries()) {
        const line = lines[ref.line - 1];
        const path = `records.${index}.facts.${field}.citations.${refIndex}`;
        if (line === undefined)
          throw new AppError('wiki_generation', `${path}: source line ${ref.line} is out of range`);
        if (line.includes(ref.quote)) continue;
        // Accept formatting-only whitespace changes, retaining an exact original-source quote.
        const words = ref.quote.trim().split(/\s+/).filter(Boolean);
        const pattern = words
          .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('\\s+');
        const match = pattern ? new RegExp(pattern).exec(line) : null;
        if (!match)
          throw new AppError(
            'wiki_generation',
            `${path}: quotation does not match source line ${ref.line}`,
          );
        ref.quote = match[0];
      }
    }
  }
  return parsed.data;
}
