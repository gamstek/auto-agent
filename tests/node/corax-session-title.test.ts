import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coraxChannel } from '@coraxjs/core/channels/corax';
import { httpBasic } from '@coraxjs/core/channels/auth';

// Operator-approved patch contract tests only; application modules use native HTTP.
const sdk = dirname(fileURLToPath(import.meta.resolve('@coraxjs/core')));
const { createWorld } = await import(
  pathToFileURL(join(sdk, 'compiled/@workflow/world-local/index.js')).href
);
const { setWorld } = await import(pathToFileURL(join(sdk, 'internal/workflow/runtime.js')).href);
const auth = `Basic ${Buffer.from('fixture:password').toString('base64')}`;
const channel = coraxChannel({ auth: [httpBasic({ username: 'fixture', password: 'password' })] });
const rename = channel.routes.find(
  (route) => route.method === 'PATCH' && route.path.endsWith('/:sessionId/title'),
)!;
const catalog = channel.routes.find(
  (route) => route.method === 'GET' && route.path === '/corax/v1/session',
)!;
assert.ok(rename && rename.transport !== 'websocket');
assert.ok(catalog && catalog.transport !== 'websocket');

function context(id: string) {
  return { params: { sessionId: id }, requestIp: '127.0.0.1' } as any;
}
async function change(id: string, body: unknown, authorization = auth) {
  if (rename.transport === 'websocket') throw new Error('Unexpected transport');
  return rename.handler(
    new Request(`http://localhost/corax/v1/session/${id}/title`, {
      method: 'PATCH',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    context(id),
  );
}

test('authenticated title updates persist on the stable anchor without session dispatch or event writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corax-title-'));
  let world = createWorld({ dataDir: directory, recoverActiveRuns: false, queueAuthKey: 'read' });
  setWorld(world);
  try {
    const original = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: 8,
      eventData: {
        deploymentId: 'fixture',
        workflowName: 'workflow//fixture',
        input: new Uint8Array(),
        allowReservedAttributes: true,
        attributes: { '$corax.type': 'session', '$corax.title': 'original' },
      },
    });
    const id = original.run.runId;
    const before = await world.events.list({ runId: id });
    const denied = await change(id, { title: 'denied' }, '');
    assert.equal(denied.status, 401);
    const saved = await change(id, { title: '  新的会话名称  ' });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { id, title: '新的会话名称' });
    assert.equal((await world.events.list({ runId: id })).data.length, before.data.length);
    const handoff = await world.events.create(null, {
      eventType: 'run_created',
      specVersion: 8,
      eventData: {
        deploymentId: 'fixture',
        workflowName: 'workflow//fixture',
        input: new Uint8Array(),
        allowReservedAttributes: true,
        attributes: {
          '$corax.type': 'session',
          '$corax.session': id,
          '$corax.title': 'stale handoff title',
        },
      },
    });
    assert.equal((await change(handoff.run.runId, { title: 'wrong anchor' })).status, 404);
    await world.close();
    world = createWorld({ dataDir: directory, recoverActiveRuns: false, queueAuthKey: 'read' });
    setWorld(world);
    assert.equal((await world.runs.get(id)).attributes['$corax.user_title'], '新的会话名称');
    const listed = await catalog.handler(
      new Request('http://localhost/corax/v1/session', {
        headers: { authorization: auth },
      }),
      context(id),
    );
    assert.equal(listed.status, 200);
    const rows = (await listed.json()).sessions;
    assert.equal(rows.filter((row: any) => row.id === id).length, 1);
    assert.equal(rows.find((row: any) => row.id === id).title, '新的会话名称');
    for (const body of [
      { title: '' },
      { title: '  ' },
      { title: 'line\nbreak' },
      { title: 'x'.repeat(101) },
      { title: 'x', extra: true },
      { title: 1 },
      { title: 'x'.repeat(5000) },
    ])
      assert.equal((await change(id, body)).status, 400);
    assert.equal((await change('invalid', { title: 'x' })).status, 400);
    assert.equal((await change('wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB', { title: 'x' })).status, 404);
  } finally {
    await world.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
