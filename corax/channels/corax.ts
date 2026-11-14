import { coraxChannel } from '@coraxjs/core/channels/corax';
import { httpBasic, localDev } from '@coraxjs/core/channels/auth';
import { timeHistoryRoute } from '../lib/diagnostics/history-timing';

const password = process.env.AUTO_AGENT_TOKEN;
const channel = coraxChannel({
  auth: password ? [httpBasic({ username: 'auto-agent', password })] : [localDev()],
});

export default {
  ...channel,
  routes: channel.routes.map((route) =>
    route.transport !== 'websocket' &&
    route.method === 'GET' &&
    route.path === '/corax/v1/session/:sessionId/stream'
      ? { ...route, handler: timeHistoryRoute(route.handler) }
      : route,
  ),
};
