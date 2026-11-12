import { defineChannel, GET, POST } from '@coraxjs/core/channels';
import { z } from 'zod';
import { approvalSetting, setApprovalSetting } from '../lib/approval';

const update = z
  .object({
    mode: z.enum(['always', 'once', 'never']),
    revision: z.number().int().nonnegative(),
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
      return Response.json(approvalSetting());
    }),
    POST('/desktop/approval', async (request) => {
      if (!authorized(request)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const parsed = update.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: '审批策略参数无效' }, { status: 400 });
      const { mode, revision } = parsed.data;
      try {
        return Response.json(setApprovalSetting(mode, revision));
      } catch {
        return Response.json({ error: '尚未修改审批策略，请重新读取当前策略。' }, { status: 409 });
      }
    }),
  ],
});
