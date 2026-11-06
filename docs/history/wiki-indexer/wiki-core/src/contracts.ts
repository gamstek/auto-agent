import { z } from 'zod';

export class WikiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const sourceSchema = z
  .object({
    id: identifier,
    type: z.enum(['directory', 'file']),
    path: z.string().min(1).max(4096),
    collection: identifier.default('default'),
    include: z.array(z.string().min(1).max(256)).max(32).default(['**/*']),
    exclude: z.array(z.string().min(1).max(256)).max(32).default([]),
  })
  .strict();
export type Source = z.infer<typeof sourceSchema>;
export type SourceInput = z.input<typeof sourceSchema>;
export const wikiConfigSchema = z
  .object({
    sources: z.array(sourceSchema).max(100).default([]),
    parsers: z.array(identifier).max(32).optional(),
    enrichment: z
      .object({ enabled: z.literal(false).default(false) })
      .strict()
      .optional(),
  })
  .strict();
export interface FieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean';
  unit?: string;
}
export type Attributes = Record<string, string | number | boolean | null>;
export type Locator =
  | { kind: 'lines'; start: number; end: number }
  | { kind: 'json-pointer'; pointer: string }
  | { kind: 'section'; name: string };
export interface ParsedUnit {
  text: string;
  locator: Locator;
  data?: unknown;
}
export interface ParsedDocument {
  title: string;
  mediaType: string;
  attributes: Attributes;
  units: ParsedUnit[];
  issues: string[];
}
export interface SourceSnapshot {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}
export interface DocumentParser {
  id: string;
  version: string;
  fields: readonly FieldDefinition[];
  supports(path: string): boolean;
  parse(source: SourceSnapshot, context: { signal: AbortSignal }): Promise<ParsedDocument>;
}
export const referenceSchema = z
  .object({
    documentId: z.string().regex(/^[a-f0-9]{64}$/),
    versionId: z.string().regex(/^[a-f0-9]{64}$/),
    representationId: z.string().regex(/^[a-f0-9]{64}$/),
    unitId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type Reference = z.infer<typeof referenceSchema>;
export const searchSchema = z
  .object({
    query: z.string().trim().max(1000).default(''),
    sourceId: identifier.optional(),
    collection: identifier.optional(),
    filters: z
      .array(
        z
          .object({
            field: z.string().max(128),
            op: z.enum(['eq', 'gte', 'lte']),
            value: z.union([z.string().max(256), z.number().finite(), z.boolean()]),
          })
          .strict(),
      )
      .max(16)
      .default([]),
    limit: z.number().int().min(1).max(50).default(10),
    cursor: z.string().max(4096).optional(),
  })
  .strict();
export type SearchInput = z.input<typeof searchSchema>;
export const readSchema = z
  .object({
    reference: referenceSchema,
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(20),
    maxBytes: z.number().int().min(512).max(262144).default(32768),
  })
  .strict();
export type ReadInput = z.input<typeof readSchema>;
export interface BuildResult {
  generation: string;
  documents: number;
  parsed: number;
  unsupported: number;
  reused: number;
  rebuilt: number;
  removed: number;
}

export class ParserRegistry {
  readonly fields = new Map<string, FieldDefinition>();
  constructor(readonly parsers: readonly DocumentParser[]) {
    const ids = new Set<string>();
    for (const parser of parsers) {
      if (!identifier.safeParse(parser.id).success || !parser.version || ids.has(parser.id))
        throw new WikiError('parser_registration', 'Invalid or duplicate parser identity');
      ids.add(parser.id);
      for (const field of parser.fields) {
        if (
          !/^[a-z][a-z0-9_.-]+\.[a-zA-Z][a-zA-Z0-9]*$/.test(field.name) ||
          this.fields.has(field.name)
        )
          throw new WikiError('parser_registration', 'Invalid or duplicate namespaced field');
        this.fields.set(field.name, field);
      }
    }
  }
  select(path: string) {
    const matches = this.parsers.filter((parser) => parser.supports(path));
    if (matches.length > 1)
      throw new WikiError('parser_ambiguous', 'Multiple parsers match this document');
    return matches[0];
  }
  validate(parser: DocumentParser, value: ParsedDocument): void {
    if (
      !value ||
      typeof value.title !== 'string' ||
      value.title.length > 512 ||
      typeof value.mediaType !== 'string' ||
      !Array.isArray(value.units) ||
      value.units.length > 10000 ||
      !Array.isArray(value.issues)
    )
      throw new WikiError('parser_output', 'Parser returned invalid document metadata');
    if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024)
      throw new WikiError('parser_limit', 'Parsed document exceeds 4 MiB');
    for (const [name, item] of Object.entries(value.attributes)) {
      const field = parser.fields.find((field) => field.name === name);
      if (
        !field ||
        (item !== null &&
          (typeof item !== field.type || (typeof item === 'number' && !Number.isFinite(item))))
      )
        throw new WikiError('parser_output', 'Parser returned an undeclared or invalid field');
    }
    for (const unit of value.units) {
      if (typeof unit.text !== 'string' || Buffer.byteLength(JSON.stringify(unit)) > 128 * 1024)
        throw new WikiError('parser_limit', 'Parsed unit exceeds its size limit');
      const locator = unit.locator;
      if (
        !locator ||
        !(
          (locator.kind === 'lines' &&
            Number.isSafeInteger(locator.start) &&
            locator.start > 0 &&
            Number.isSafeInteger(locator.end) &&
            locator.end >= locator.start) ||
          (locator.kind === 'json-pointer' &&
            (locator.pointer === '' || locator.pointer.startsWith('/'))) ||
          (locator.kind === 'section' &&
            typeof locator.name === 'string' &&
            locator.name.length > 0)
        )
      )
        throw new WikiError('parser_output', 'Parser returned an invalid source locator');
    }
  }
}
