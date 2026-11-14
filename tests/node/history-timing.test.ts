import assert from 'node:assert/strict';
import test from 'node:test';
import type { HttpRouteDefinition, RouteHandlerArgs } from '@coraxjs/core/channels';
import { timeHistoryRoute } from '../../corax/lib/diagnostics/history-timing';
import { coraxChannel } from '@coraxjs/core/channels/corax';

test('finite history timing preserves public operation arguments, receiver and response body', async () => {
  const stream = new ReadableStream();
  const options = { follow: false, startIndex: -512 };
  const session = {
    id: 'fixture',
    async getStreamTailIndex() {
      assert.equal(this, session);
      return 99;
    },
    async getEventStream(value: unknown) {
      assert.equal(this, session);
      assert.equal(value, options);
      return stream;
    },
  };
  const context = {
    attachSession(id: string) {
      assert.equal(this, context);
      assert.equal(id, 'fixture');
      return session;
    },
  } as unknown as RouteHandlerArgs;
  const handler: HttpRouteDefinition['handler'] = async (_request, observed) => {
    const attached = observed.attachSession('fixture');
    const [tail, result] = await Promise.all([
      attached.getStreamTailIndex(),
      attached.getEventStream(options),
    ]);
    assert.equal(tail, 99);
    assert.equal(result, stream);
    return new Response('original-body', { status: 200, headers: { 'x-original': 'yes' } });
  };
  const response = await timeHistoryRoute(handler)(
    new Request('http://localhost/stream?follow=false'),
    context,
  );
  assert.equal(await response.text(), 'original-body');
  assert.equal(response.headers.get('x-original'), 'yes');
  for (const field of ['tail', 'stream', 'handler'])
    assert.match(response.headers.get(`x-auto-agent-history-${field}-ms`)!, /^\d+$/);
});

test('live subscriptions retain the original context and response without timing interception', async () => {
  const context = {} as RouteHandlerArgs;
  const response = new Response('live');
  const wrapped = timeHistoryRoute(async (_request, observed) => {
    assert.equal(observed, context);
    return response;
  });
  assert.equal(await wrapped(new Request('http://localhost/stream'), context), response);
  assert.equal(response.headers.get('x-auto-agent-history-handler-ms'), null);
});

test('native history route exposes timing while retaining the native tail and body', async () => {
  const channel = coraxChannel({
    auth: async () => ({
      authenticator: 'fixture',
      issuer: 'local',
      principalType: 'service',
      principalId: 'fixture',
      subject: 'fixture',
      attributes: {},
    }),
  });
  const route = channel.routes.find(
    (route) =>
      route.transport !== 'websocket' &&
      route.method === 'GET' &&
      route.path === '/corax/v1/session/:sessionId/stream',
  );
  assert.ok(route && route.transport !== 'websocket');
  const id = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
  let tails = 0;
  const context = {
    params: { sessionId: id },
    requestIp: '127.0.0.1',
    attachSession: () => ({
      id,
      async getStreamTailIndex() {
        tails++;
        return 0;
      },
      async getEventStream() {
        return new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'session.started', data: {} });
            controller.close();
          },
        });
      },
    }),
  } as unknown as RouteHandlerArgs;
  const response = await timeHistoryRoute(route.handler)(
    new Request(`http://localhost/corax/v1/session/${id}/stream?follow=false`),
    context,
  );
  assert.equal(response.status, 200);
  assert.equal(tails, 1);
  assert.equal(response.headers.get('x-corax-stream-tail-index'), '0');
  assert.match(response.headers.get('x-auto-agent-history-tail-ms')!, /^\d+$/);
  assert.equal(JSON.parse((await response.text()).trim()).type, 'session.started');
});
