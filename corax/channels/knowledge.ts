import { defineChannel, GET, POST } from '@coraxjs/core/channels';
import { pageReferenceSchema } from '@auto-agent/llm-wiki/contracts';
import { z } from 'zod';
import { getRuntimeConfig, getRuntimeConfigRevision } from '../lib/config';
import { getLlmWiki } from '../lib/wiki';
import { ingestLlmWiki } from '../lib/wiki/ingest';
import { knowledgeOperations, knowledgeSnapshot } from '../lib/wiki/desktop';

function authorized(request: Request) {
  const token = process.env.AUTO_AGENT_TOKEN;
  return (
    !!token &&
    request.headers.get('authorization') ===
      `Basic ${Buffer.from(`auto-agent:${token}`).toString('base64')}`
  );
}
const startInput = z
  .object({
    operationId: z.string().uuid(),
    configRevision: z.string().regex(/^[a-f0-9]{64}$/),
    sourceId: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
      .optional(),
  })
  .strict();
const cancelInput = z.object({ operationId: z.string().uuid() }).strict();
const readInput = z
  .object({ reference: pageReferenceSchema, offset: z.number().int().nonnegative().default(0) })
  .strict();

export default defineChannel({
  routes: [
    GET('/desktop/knowledge', async (request) => {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        return Response.json({
          ...(await knowledgeSnapshot(getRuntimeConfig())),
          configRevision: getRuntimeConfigRevision(),
        });
      } catch {
        return Response.json(
          { error: '无法读取知识库，请核对已发布内容和目录权限' },
          { status: 503 },
        );
      }
    }),
    GET('/desktop/knowledge/operation', async (request) => {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      return Response.json({
        operation: knowledgeOperations.snapshot(),
        configRevision: getRuntimeConfigRevision(),
      });
    }),
    GET('/desktop/knowledge/pages', async (request) => {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        const offset = z.coerce
          .number()
          .int()
          .nonnegative()
          .parse(new URL(request.url).searchParams.get('offset') ?? 0);
        const generation = new URL(request.url).searchParams.get('generation') ?? undefined;
        return Response.json(await getLlmWiki().catalog(offset, 20, generation));
      } catch {
        return Response.json({ error: '无法读取知识页目录' }, { status: 400 });
      }
    }),
    POST('/desktop/knowledge/read', async (request) => {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        const input = readInput.parse(await request.json());
        // Generated Markdown can contain a legal single line larger than the
        // tool's default 32 KiB page. Keep the compiler's bounded read maximum.
        return Response.json(await getLlmWiki().read(input.reference, input.offset, 60, 262144));
      } catch {
        return Response.json({ error: '知识页引用或版本无效，请刷新目录' }, { status: 400 });
      }
    }),
    POST('/desktop/knowledge/ingest', async (request, context) => {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        const input = startInput.parse(await request.json());
        const config = getRuntimeConfig();
        if (input.configRevision !== getRuntimeConfigRevision())
          return Response.json({ error: '后端配置已变化，请重新连接后再整理' }, { status: 409 });
        if (
          input.sourceId &&
          !config.llmWiki.sources.some((source) => source.id === input.sourceId)
        )
          return Response.json({ error: '资料来源尚未生效，请等待设置应用' }, { status: 409 });
        const operation = knowledgeOperations.start(input.operationId, (signal, progress) =>
          ingestLlmWiki(config, input.sourceId, signal, progress),
        );
        try {
          context.waitUntil(operation.done);
        } catch {
          return Response.json({ error: '整理已经受理，后台状态需重新核对' }, { status: 503 });
        }
        return Response.json(
          { operation: { ...operation.value }, configRevision: getRuntimeConfigRevision() },
          { status: 202 },
        );
      } catch {
        return Response.json({ error: '请求无效或已有知识整理正在执行' }, { status: 409 });
      }
    }),
    POST('/desktop/knowledge/cancel', async (request) => {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        const input = cancelInput.parse(await request.json());
        return Response.json({
          operation: knowledgeOperations.cancel(input.operationId),
          configRevision: getRuntimeConfigRevision(),
        });
      } catch {
        return Response.json({ error: '整理记录已变化，请刷新状态' }, { status: 409 });
      }
    }),
  ],
});
