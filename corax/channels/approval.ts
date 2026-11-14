import { defineChannel, GET, POST } from '@coraxjs/core/channels';
import { z } from 'zod';
import { ApprovalConflictError, approvalSetting, setApprovalSetting } from '../lib/approval';
import { getRuntimeConfigRevision } from '../lib/config';

const update = z
  .object({
    mode: z.enum(['always', 'once', 'never']),
    revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
function authorized(request: Request) {
  const token = process.env.AUTO_AGENT_TOKEN;
  return (
    !!token &&
    request.headers.get('authorization') ===
      `Basic ${Buffer.from(`auto-agent:${token}`).toString('base64')}`
  );
}

export default defineChannel({
  routes: [
    GET('/desktop/approval', async (request) => {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        return Response.json({ ...approvalSetting(), configRevision: getRuntimeConfigRevision() });
      } catch {
        return Response.json(
          { error: '无法读取已保存的批准策略，请检查设置后重新读取。' },
          { status: 503 },
        );
      }
    }),
    POST('/desktop/approval', async (request) => {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const parsed = update.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: '审批策略参数无效' }, { status: 400 });
      const { mode, revision } = parsed.data;
      try {
        return Response.json({
          ...setApprovalSetting(mode, revision),
          configRevision: getRuntimeConfigRevision(),
        });
      } catch (error) {
        return Response.json(
          {
            error:
              error instanceof ApprovalConflictError
                ? '尚未修改审批策略，请重新读取当前策略。'
                : '批准策略保存失败，请重新读取当前策略后再试。',
          },
          { status: error instanceof ApprovalConflictError ? 409 : 503 },
        );
      }
    }),
  ],
});
