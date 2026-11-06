import { defineChannel, GET, POST } from '@coraxjs/core/channels';
import { instruments, refreshClimber } from '../lib/climber/instruments';

function authorized(request: Request) {
  const token = process.env.AUTO_AGENT_TOKEN;
  return (
    !!token &&
    request.headers.get('authorization') ===
      `Basic ${Buffer.from(`auto-agent:${token}`).toString('base64')}`
  );
}

/** Authenticated desktop read projection; no device writes or arbitrary MCP invocation. */
export default defineChannel({
  routes: [
    GET('/desktop/devices', async (request) =>
      authorized(request)
        ? Response.json(instruments())
        : Response.json({ error: 'Unauthorized' }, { status: 401 }),
    ),
    POST('/desktop/devices/climber/refresh', async (request) =>
      authorized(request)
        ? Response.json(await refreshClimber(request.signal))
        : Response.json({ error: 'Unauthorized' }, { status: 401 }),
    ),
  ],
});
