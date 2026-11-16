import { defineChannel, POST } from '@coraxjs/core/channels';
import { getRuntimeConfig } from '../lib/config';
import { sessionTitleInput, sessionTitles } from '../lib/session-title';

export default defineChannel({
  routes: [
    POST('/desktop/session-title', async (request) => {
      const token = process.env.AUTO_AGENT_TOKEN;
      if (
        !token ||
        request.headers.get('authorization') !==
          `Basic ${Buffer.from(`auto-agent:${token}`).toString('base64')}`
      )
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        const { content } = sessionTitleInput.parse(await request.json());
        return Response.json(await sessionTitles.generate(getRuntimeConfig(), content));
      } catch {
        return Response.json({ error: '会话主题请求无效' }, { status: 400 });
      }
    }),
  ],
});
