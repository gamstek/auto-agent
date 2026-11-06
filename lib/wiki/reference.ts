import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { terms } from '@auto-agent/llm-wiki';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fingerprints = new Map<string, { size: number; mtimeMs: number; digest: string }>();
function assetDigest(path: string) {
  const info = statSync(path);
  const previous = fingerprints.get(path);
  if (previous?.size === info.size && previous.mtimeMs === info.mtimeMs) return previous.digest;
  const digest = hash(readFileSync(path));
  fingerprints.set(path, { size: info.size, mtimeMs: info.mtimeMs, digest });
  return digest;
}
export const evidenceReference = z
  .object({
    assetSha256: z.string().regex(/^[a-f0-9]{64}$/),
    documentId: z.string(),
    representationId: z.string(),
  })
  .strict();
export const referenceFilters = z
  .record(z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/), z.string().max(200))
  .refine((value) => Object.keys(value).length <= 10, '最多提供10项元数据过滤条件');
export const referenceInput = z.discriminatedUnion('action', [
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
      query: z.string().max(1000).default(''),
      filters: referenceFilters.optional(),
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(20).default(5),
    })
    .strict(),
  z
    .object({
      action: z.literal('read'),
      reference: evidenceReference,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(200).default(60),
      maxBytes: z.number().int().min(1024).max(262144).default(32768),
    })
    .strict(),
]);

/** Read-only indexed collection adapter. Its data binding belongs to the application. */
export function queryReference(
  input: z.output<typeof referenceInput>,
  source: { path: string; parserId: string; note: string },
) {
  const path = source.path;
  const digest = assetDigest(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (input.action === 'catalog') {
      const keys = db
        .prepare(
          "SELECT DISTINCT a.key FROM documents d JOIN representations r ON r.id=d.representationId JOIN json_each(r.attributes) a WHERE d.active=1 AND r.parserId=? AND typeof(a.value)='text' ORDER BY a.key LIMIT ? OFFSET ?",
        )
        .all(source.parserId, input.limit + 1, input.offset);
      return {
        readOnly: true,
        documentCount: db
          .prepare(
            'SELECT count(*) AS count FROM documents d JOIN representations r ON r.id=d.representationId WHERE d.active=1 AND r.parserId=?',
          )
          .get(source.parserId)!.count,
        filterKeys: keys.slice(0, input.limit).map((row) => row.key),
        nextOffset: keys.length > input.limit ? input.offset + input.limit : null,
        assetSha256: digest,
        sourceVerified: false,
        note: source.note,
      };
    }
    if (input.action === 'search') {
      const words = terms(input.query);
      if (words.length > 128) throw new Error('查询词过多，请缩小范围');
      const query = words.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
      const params: (string | number)[] = [source.parserId];
      let where = 'd.active=1 AND r.parserId=?';
      if (query) {
        where += ' AND wiki_fts MATCH ?';
        params.push(query);
      } else where += ' AND u.ordinal=0';
      for (const [key, value] of Object.entries(input.filters ?? {})) {
        where += ' AND EXISTS(SELECT 1 FROM json_each(r.attributes) a WHERE a.key=? AND a.value=?)';
        params.push(key, value);
      }
      const rows = db
        .prepare(
          `WITH hits AS MATERIALIZED (
        SELECT d.id,d.path,r.id AS representationId,r.title,r.attributes,v.sha256,u.text,u.locator,u.ordinal,${query ? 'bm25(wiki_fts)' : '0'} AS score
        FROM documents d JOIN representations r ON r.id=d.representationId JOIN versions v ON v.id=d.versionId
        JOIN units u ON u.representationId=r.id ${query ? 'JOIN wiki_fts ON wiki_fts.unitId=u.id' : ''} WHERE ${where})
        SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY id ORDER BY score,ordinal) AS position FROM hits)
        WHERE position=1 ORDER BY score,id LIMIT ? OFFSET ?`,
        )
        .all(...params, input.limit + 1, input.offset);
      return {
        results: rows.slice(0, input.limit).map((row) => ({
          reference: {
            assetSha256: digest,
            documentId: row.id,
            representationId: row.representationId,
          },
          title: row.title,
          origin: row.path,
          sourceSha256: row.sha256,
          attributes: JSON.parse(row.attributes as string),
          snippet: (row.text as string).slice(0, 800),
          snippetTruncated: (row.text as string).length > 800,
          locator: JSON.parse(row.locator as string),
        })),
        nextOffset: rows.length > input.limit ? input.offset + input.limit : null,
        sourceVerified: false,
      };
    }
    if (input.reference.assetSha256 !== digest) throw new Error('内置资料版本已经变化，请重新检索');
    const document = db
      .prepare(
        'SELECT d.path,r.title,r.attributes,v.sha256,r.parserId,r.parserVersion FROM documents d JOIN representations r ON r.id=d.representationId JOIN versions v ON v.id=d.versionId WHERE d.id=? AND r.id=? AND d.active=1 AND r.parserId=?',
      )
      .get(input.reference.documentId, input.reference.representationId, source.parserId);
    if (!document) throw new Error('内置历史参考不存在');
    const rows = db
      .prepare(
        'SELECT text,locator,data FROM units WHERE representationId=? ORDER BY ordinal LIMIT ? OFFSET ?',
      )
      .all(input.reference.representationId, input.limit + 1, input.offset);
    const units: unknown[] = [];
    const metadata = {
      reference: input.reference,
      title: document.title,
      origin: document.path,
      sourceSha256: document.sha256,
      parser: { id: document.parserId, version: document.parserVersion },
      attributes: JSON.parse(document.attributes as string),
      sourceVerified: false,
    };
    for (const row of rows.slice(0, input.limit)) {
      const unit = {
        text: row.text,
        locator: JSON.parse(row.locator as string),
        ...(row.data === null ? {} : { data: JSON.parse(row.data as string) }),
      };
      if (
        Buffer.byteLength(
          JSON.stringify({
            ...metadata,
            units: [...units, unit],
            nextOffset: input.offset + units.length + 1,
          }),
        ) > input.maxBytes
      )
        break;
      units.push(unit);
    }
    if (rows.length && !units.length) throw new Error('单个证据单元超出读取预算，请提高 maxBytes');
    return {
      ...metadata,
      units,
      nextOffset: rows.length > units.length ? input.offset + units.length : null,
    };
  } finally {
    db.close();
  }
}
