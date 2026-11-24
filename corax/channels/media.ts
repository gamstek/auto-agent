import { defineChannel, GET } from '@coraxjs/core/channels';
import { sessions } from '@coraxjs/core/server';
import { toolMedia } from '@auto-agent/desktop-protocol';
import { readChatMedia } from '../lib/media/attachments';
import { getRuntimeConfig } from '../lib/config';

export default defineChannel({
  routes: [
    GET('/desktop/chat-media', async (request) => {
      const token = process.env.AUTO_AGENT_TOKEN;
      if (
        !token ||
        request.headers.get('authorization') !==
          `Basic ${Buffer.from(`auto-agent:${token}`).toString('base64')}`
      )
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      const params = new URL(request.url).searchParams;
      const session = params.get('session') ?? '';
      const index = params.get('index') ?? '';
      const slot = params.get('slot') ?? '';
      if (
        !/^wrun_[a-zA-Z0-9]{26}$/.test(session) ||
        !/^\d{1,10}$/.test(index) ||
        !/^\d{1,2}$/.test(slot)
      )
        return Response.json({ error: '无效的附件位置' }, { status: 400 });
      try {
        for await (const event of sessions
          .attach(session)
          .stream({ follow: false, startIndex: Number(index) })) {
          if (
            event.type !== 'action.result' ||
            event.data.status !== 'completed' ||
            event.data.result.kind !== 'tool-result'
          )
            break;
          const { toolName, output } = event.data.result;
          const media = toolMedia(toolName, output)[Number(slot)];
          if (!media || media.kind === 'data') break;
          if (media.kind === 'url' && params.get('load') !== '1')
            return Response.json({ error: '请先确认加载远程附件' }, { status: 403 });
          return Response.json(
            await readChatMedia(media, {
              dataDir: getRuntimeConfig().dataDir,
              id: `${event.meta.id}:${Number(slot)}`,
              signal: request.signal,
            }),
            {
              headers: { 'Cache-Control': 'no-store' },
            },
          );
        }
      } catch {
        /* Do not expose the source path or remote URL to the WebView. */
      }
      return Response.json({ error: '附件不可用' }, { status: 404 });
    }),
  ],
});
