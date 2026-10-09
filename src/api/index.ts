import { timingSafeEqual } from 'node:crypto';
import type { AgentService } from '../agent';
import { AppError, errorText } from '../shared/types';
import { home, llmText } from './home';
function authorized(request: Request, token: string): boolean {
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function handler(service: AgentService): (request: Request) => Promise<Response> {
  if (service.config.noToken && !['127.0.0.1', 'localhost', '::1'].includes(service.config.host))
    throw new AppError('no_token_remote', '--no-token is only permitted on loopback.');
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
    try {
      if (request.method === 'GET' && path === '/')
        return new Response(home(Boolean(service.config.noToken)), {
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy':
              "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            'Referrer-Policy': 'no-referrer',
          },
        });
      if (request.method === 'GET' && (path === '/llm.txt' || path === '/llms.txt'))
        return new Response(llmText, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      if (request.method === 'GET' && path === '/global/health')
        return json({ healthy: true, version: '0.1.0' });
      if (!service.config.noToken && !authorized(request, service.config.token))
        return json({ error: 'unauthorized' }, 401);
      if (request.method === 'GET' && path === '/event')
        return new Response(
          service.events.stream(request.signal, service.config.maxConcurrent * 8),
          {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'X-Accel-Buffering': 'no',
            },
          },
        );
      const body = async (): Promise<Record<string, unknown>> => {
        const declared = Number(request.headers.get('content-length') ?? 0);
        if (declared > service.config.requestLimitBytes)
          throw new AppError('body_limit', 'Request body too large', 413);
        if (!request.body) return {};
        const reader = request.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            size += item.value.byteLength;
            if (size > service.config.requestLimitBytes) {
              await reader.cancel();
              throw new AppError('body_limit', 'Request body too large', 413);
            }
            chunks.push(item.value);
          }
        } finally {
          reader.releaseLock();
        }
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
          return value;
        } catch {
          throw new AppError('invalid_json', 'Expected a JSON object');
        }
      };
      if (path === '/session') {
        if (request.method === 'GET') return json(service.store.listSessions());
        if (request.method === 'POST') {
          const input = await body();
          if (
            input.title !== undefined &&
            (typeof input.title !== 'string' || input.title.length > 200)
          )
            throw new AppError('invalid_title', 'Title must be a string of at most 200 characters');
          return json(service.store.createSession(input.title as string | undefined), 201);
        }
      }
      const match = /^\/session\/([^/]+)(?:\/(message|prompt_async|abort))?$/.exec(path);
      if (!match) throw new AppError('not_found', 'Route not found', 404);
      const [, id, action] = match;
      service.store.getSession(id);
      if (request.method === 'GET' && !action) return json(service.store.getSession(id));
      if (request.method === 'GET' && action === 'message') return json(service.store.messages(id));
      if (request.method === 'POST' && action === 'abort')
        return json({ aborted: await service.abort(id) });
      if (request.method === 'POST' && (action === 'message' || action === 'prompt_async')) {
        const input = await body();
        if (typeof input.content !== 'string')
          throw new AppError('invalid_message', 'content must be a string');
        const done = service.submit(id, input.content);
        if (action === 'prompt_async') {
          void done.catch(() => {});
          return new Response(null, { status: 204 });
        }
        return json(await done);
      }
      throw new AppError('not_found', 'Route not found', 404);
    } catch (error) {
      return json(
        {
          error: error instanceof AppError ? error.code : 'internal_error',
          message: errorText(error),
        },
        error instanceof AppError ? error.status : 500,
      );
    }
  };
}
export function serve(service: AgentService) {
  return Bun.serve({
    hostname: service.config.host,
    port: service.config.port,
    idleTimeout: 0,
    maxRequestBodySize: service.config.requestLimitBytes,
    fetch: handler(service),
  });
}
