import { defineChannel, POST, SessionStrandedError } from '@coraxjs/core/channels';
import { sessions } from '@coraxjs/core/server';
import { conversationReducer } from '@coraxjs/core/client';
import { z } from 'zod';

const input = z
  .object({
    sessions: z
      .array(
        z
          .object({
            id: z.string().regex(/^wrun_[a-zA-Z0-9]{26}$/),
            after: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

/** Host activity only. Chat commands and event streams stay on the native Corax routes. */
export default defineChannel({
  routes: [
    POST('/desktop/activity', async (request, context) => {
      const token = process.env.AUTO_AGENT_TOKEN;
      if (
        !token ||
        request.headers.get('authorization') !==
          `Basic ${Buffer.from(`auto-agent:${token}`).toString('base64')}`
      )
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      try {
        const query = input.parse(await request.json());
        const result = await Promise.all(
          query.sessions.map(async ({ id, after }) => {
            let state = conversationReducer.initial();
            let revision = 0;
            let closed = false;
            let admissionObserved = false;
            for await (const event of sessions
              .attach(id)
              .stream({ follow: false, startIndex: 0 })) {
              state = conversationReducer.reduce(state, event);
              if (
                after !== null &&
                revision >= after &&
                [
                  'turn.started',
                  'message.received',
                  'input.resolved',
                  'session.completed',
                  'session.failed',
                ].includes(event.type)
              )
                admissionObserved = true;
              revision++;
              if (event.type === 'session.completed' || event.type === 'session.failed')
                closed = true;
            }
            const turnActive = Object.values(state.turns).some((turn) => turn.status === 'active');
            const working = Object.values(state.tasks).some((task) =>
              Object.values(task.calls).some((call) => call.status === 'working'),
            );
            if (!closed && (turnActive || working || after !== null)) {
              try {
                const stream = await context
                  .attachSession(id)
                  .getEventStream({ startIndex: revision });
                await stream.cancel();
              } catch (error) {
                if (error instanceof SessionStrandedError) closed = true;
                else throw error;
              }
            }
            return {
              id,
              revision,
              closed,
              admissionObserved,
              busy: !closed && (turnActive || working),
              turnActive: !closed && turnActive,
            };
          }),
        );
        return Response.json({ sessions: result });
      } catch {
        return Response.json({ error: '无法确认 Corax 会话活动状态' }, { status: 503 });
      }
    }),
  ],
});
