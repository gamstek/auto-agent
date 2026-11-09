import { defineChannel, POST } from '@coraxjs/core/channels';
import { z } from 'zod';
import { getRuntimeConfig } from '../lib/config';
import { questionSuggestions, recentSessionsSchema } from '../lib/suggestions';

const input = z.object({ sessions: recentSessionsSchema }).strict();

export default defineChannel({
  routes: [
    POST('/desktop/suggestions', async (request) => {
      const token = process.env.AUTO_AGENT_TOKEN;
      if (
        !token ||
        request.headers.get('authorization') !==
          `Basic ${Buffer.from(`auto-agent:${token}`).toString('base64')}`
      )
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        const query = input.parse(await request.json());
        return Response.json(await questionSuggestions.get(getRuntimeConfig(), query.sessions));
      } catch {
        return Response.json({ error: '推荐问题请求无效' }, { status: 400 });
      }
    }),
  ],
});
