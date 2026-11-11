import { defineTool } from '@coraxjs/core/tools';
import { z } from 'zod';
import { llmWikiInput, pageReferenceSchema } from '@auto-agent/llm-wiki/contracts';
import { getLlmWiki, referenceSource } from '../lib/wiki';
import { ingestLlmWiki } from '../lib/wiki/ingest';
import {
  evidenceReference,
  queryReference,
  referenceFilters,
  referenceInput,
} from '../lib/wiki/reference';
import { getRuntimeConfig } from '../lib/config';

const [catalog, search, read, source, resolve] = llmWikiInput.options;
const collection = z.enum(['knowledge', 'reference']).default('knowledge');
const knowledge = z.literal('knowledge').default('knowledge');

export default defineTool({
  description:
    'Agent 通用 Wiki 能力。collections 查看资料集合；collection=knowledge（默认）查询用户 Markdown 知识，reference 查询随版本发布的只读证据。catalog/search/read 查看目录、检索和按实际 reference 分页阅读；reference 支持 catalog 返回的元数据 filterKeys，filters 为键值条件。查询与引用始终保留 collection，跟随 nextOffset。knowledge 的 source 回读固定原文；ingest 仅在用户明确要求摄入或更新时调用模型并持久生成知识页，只处理 llmWiki.sources，失败/取消说明 completed、不自动重试。resolve 只按用户明确结论关闭指定 issueId，不改正文或给予科学批准。区分原文、历史证据和 LLM 综合；工具只读查询不会自动摄入。没有 SQL、数据库路径或资料包导入操作。',
  inputSchema: z.discriminatedUnion('action', [
    z.object({ action: z.literal('collections') }).strict(),
    catalog.extend({ collection }),
    search.extend({ collection, filters: referenceFilters.optional() }),
    read.extend({ collection, reference: z.union([pageReferenceSchema, evidenceReference]) }),
    source.extend({ collection: knowledge }),
    resolve.extend({ collection: knowledge }),
    z
      .object({
        action: z.literal('ingest'),
        collection: knowledge,
        sourceId: z.string().max(128).optional(),
      })
      .strict(),
  ]),
  label: {
    start: (input) => (input.action === 'ingest' ? '整理知识库' : '查阅资料'),
  },
  async execute(input, context) {
    if (input.action === 'collections')
      return JSON.stringify({
        collections: [
          {
            id: 'knowledge',
            name: '用户知识',
            readOnly: false,
            actions: ['catalog', 'search', 'read', 'source', 'ingest', 'resolve'],
          },
          {
            id: 'reference',
            name: '预置参考证据',
            readOnly: true,
            actions: ['catalog', 'search', 'read'],
          },
        ],
      });
    if (input.collection === 'reference') {
      const { collection, ...request } = input;
      return JSON.stringify({
        collection,
        ...queryReference(referenceInput.parse(request), referenceSource()),
      });
    }
    if (input.action === 'search' && input.filters)
      throw new Error('knowledge 集合不支持元数据 filters；请按文本 query 检索。');
    if (input.action === 'ingest')
      return JSON.stringify(
        {
          collection: input.collection,
          ...(await ingestLlmWiki(getRuntimeConfig(), input.sourceId, context.abortSignal)),
        },
        null,
        2,
      );
    const wiki = getLlmWiki();
    const configured = getRuntimeConfig().llmWiki.sources;
    const configuredLimit = input.action === 'catalog' ? Math.min(input.limit, 20) : 0;
    const result =
      input.action === 'catalog'
        ? {
            ...(await wiki.catalog(input.offset, input.limit)),
            configuredSourceCount: configured.length,
            configuredSources: configured
              .slice(input.offset, input.offset + configuredLimit)
              .map((source) => {
                const name = source.path.split(/[\\/]/).pop() ?? source.id;
                return {
                  id: source.id,
                  type: source.type,
                  name: name.slice(0, 120),
                  nameTruncated: name.length > 120,
                };
              }),
            nextConfiguredOffset:
              input.offset + configuredLimit < configured.length
                ? input.offset + configuredLimit
                : null,
          }
        : input.action === 'search'
          ? await wiki.search(input.query, input.offset, input.limit)
          : input.action === 'read'
            ? await wiki.read(
                pageReferenceSchema.parse(input.reference),
                input.offset,
                input.limit,
                input.maxBytes,
              )
            : input.action === 'resolve'
              ? await wiki.resolve(input.issueId, input.note, context.abortSignal)
              : await wiki.source(
                  input.generation,
                  input.reference,
                  input.offset,
                  input.limit,
                  input.maxBytes,
                );
    return JSON.stringify({ collection: input.collection, ...result }, null, 2);
  },
});
