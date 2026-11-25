import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { automationClient } from '../../corax/lib/automation/client';
import { configSchema } from '../../corax/lib/config/schema';

const combos = [
  { tubeCode: 'T001', templateId: 'bet-n2', versionId: 'v3' },
  { tubeCode: 'T002', templateId: 'co2-pore', versionId: 'v2' },
];
const identity = { sessionId: 'session-a', callId: 'call-a' };
type Submitted = (typeof combos)[number] & { experimentId: string };

async function fixture(
  t: TestContext,
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  timeoutMs = 2000,
) {
  const dataDir = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), 'auto-agent-automation-'),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch((error) => {
        t.diagnostic(String(error));
        res.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert(address && typeof address !== 'string');
  return configSchema.parse({
    dataDir,
    automation: {
      enabled: true,
      serviceURL: `http://127.0.0.1:${address.port}/api/automation/v1/`,
      timeoutMs,
    },
  });
}

async function body(req: IncomingMessage): Promise<{ items: Submitted[] }> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text);
}

test('one loopback request per batch; mixed templates, receipt order, and individual errors are preserved', async (t) => {
  let submitted: Submitted[] = [];
  const requests: string[] = [];
  const settings = await fixture(t, async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    requests.push(`${req.method} ${url.pathname}`);
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'application/json');
    let items: unknown[];
    if (url.pathname.endsWith('/experiment-templates')) {
      assert.deepEqual(url.searchParams.getAll('templateId'), ['bet-n2', 'co2-pore']);
      items = combos.map(({ templateId, versionId }) => ({
        templateId,
        versionId,
        name: templateId,
      }));
    } else if (url.pathname.endsWith('/experiments')) {
      submitted = (await body(req)).items;
      assert.deepEqual(
        submitted.map(({ experimentId: _, ...item }) => item),
        combos,
      );
      assert.equal(new Set(submitted.map(({ experimentId }) => experimentId)).size, 2);
      items = [
        {
          experimentId: submitted[1]!.experimentId,
          status: 'error',
          code: 'TUBE_UNAVAILABLE',
          message: '样品管不可用',
        },
        { experimentId: submitted[0]!.experimentId, status: 'accepted', tubeCode: 'T001' },
      ];
    } else {
      const ids = submitted.map(({ experimentId }) => experimentId);
      assert.deepEqual(url.searchParams.getAll('experimentId'), ids);
      items = url.pathname.endsWith('/progress')
        ? [
            {
              experimentId: ids[0],
              status: 'running',
              steps: [
                {
                  stage: 'pretreatment',
                  status: 'running',
                  startedAt: '2026-11-25T08:00:00+08:00',
                  finishedAt: null,
                },
              ],
            },
            {
              experimentId: ids[1],
              status: 'error',
              code: 'EXPERIMENT_NOT_FOUND',
              message: '无实验',
            },
          ]
        : [
            {
              experimentId: ids[0],
              status: 'ready',
              metrics: [{ name: 'BET', value: 152.4, unit: 'm²/g' }],
              isotherms: [
                { branch: 'adsorption', xUnit: 'P/P0', yUnit: 'cm³/g', points: [[0.1, 12.5]] },
              ],
            },
            { experimentId: ids[1], status: 'not_ready' },
          ];
    }
    res.end(JSON.stringify({ items }));
  });
  const client = automationClient(settings);
  assert.equal((await client.templates({ templateIds: ['bet-n2', 'co2-pore'] })).items.length, 2);
  const created = await client.create({ items: combos }, identity);
  assert.deepEqual(
    created.items.map(({ tubeCode, status }) => [tubeCode, status]),
    [
      ['T001', 'accepted'],
      ['T002', 'error'],
    ],
  );
  const experimentIds = created.items.map(({ experimentId }) => experimentId);
  const progress = await client.progress({ experimentIds });
  assert.deepEqual(
    progress.items.map(({ status }) => status),
    ['running', 'error'],
  );
  const result = await client.results({ experimentIds });
  assert.deepEqual(
    result.items.map(({ status }) => status),
    ['ready', 'not_ready'],
  );
  const first = result.items[0];
  assert(first?.status === 'ready');
  assert.deepEqual(first.isotherms[0]?.points, [[0.1, 12.5]]);
  assert.deepEqual(requests, [
    'GET /api/automation/v1/experiment-templates',
    'POST /api/automation/v1/experiments',
    'GET /api/automation/v1/experiments/progress',
    'GET /api/automation/v1/experiments/results',
  ]);
});

test('unknown writes block new calls across client instances until the original ID is confirmed', async (t) => {
  const posts: Submitted[][] = [];
  let observable = false;
  const config = await fixture(
    t,
    async (req, res) => {
      if (req.method === 'POST') {
        const { items } = await body(req);
        posts.push(items);
        if (posts.length === 1) return; // The response to the original write is lost.
        res.end(
          JSON.stringify({
            items: items.map(({ experimentId, tubeCode }) => ({
              experimentId,
              tubeCode,
              status: 'accepted',
            })),
          }),
        );
        return;
      }
      const ids = new URL(req.url!, 'http://localhost').searchParams.getAll('experimentId');
      assert.deepEqual(ids, [posts[0]![0]!.experimentId]);
      res.end(
        JSON.stringify({
          items: ids.map((experimentId) =>
            observable
              ? { experimentId, status: 'completed', steps: [] }
              : { experimentId, status: 'error', code: 'EXPERIMENT_NOT_FOUND', message: '无实验' },
          ),
        }),
      );
    },
    200,
  );
  const result = await automationClient(config).create({ items: combos }, identity);
  assert.deepEqual(
    result.items.map(({ status }) => status),
    ['unknown', 'unknown'],
  );
  const oldIds = result.items.map(({ experimentId }) => experimentId);
  const client = automationClient(config);
  const retry = (callId: string) =>
    client.create({ items: combos }, { sessionId: 'session-b', callId });
  const blocked = await retry('try-after-timeout');
  assert.deepEqual(
    blocked.items.map(({ status, experimentId }) => [status, experimentId]),
    oldIds.map((id) => ['blocked', id]),
  );
  assert.equal(posts.length, 1);

  const query = { experimentIds: [oldIds[0]!] };
  assert.equal((await client.progress(query)).items[0]?.status, 'error');
  assert((await retry('try-after-not-found')).items.every(({ status }) => status === 'blocked'));
  assert.equal(posts.length, 1);

  observable = true;
  assert.equal((await client.progress(query)).items[0]?.status, 'completed');
  const mixed = await retry('try-after-confirmation');
  assert.deepEqual(
    mixed.items.map(({ status }) => status),
    ['accepted', 'blocked'],
  );
  assert.equal(mixed.items[1]?.experimentId, oldIds[1]);
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts[1]!.map(({ tubeCode }) => tubeCode),
    ['T001'],
  );
});

test('a second call for the same tube is blocked while the first POST is still in flight', async (t) => {
  let posts = 0;
  const dispatched = Promise.withResolvers<Submitted>();
  const finish = Promise.withResolvers<void>();
  const config = await fixture(t, async (req, res) => {
    posts++;
    const {
      items: [item],
    } = await body(req);
    dispatched.resolve(item!);
    await finish.promise;
    res.end(
      JSON.stringify({
        items: [{ experimentId: item!.experimentId, tubeCode: item!.tubeCode, status: 'accepted' }],
      }),
    );
  });
  const input = { items: [combos[0]!] };
  const first = automationClient(config).create(input, identity);
  const original = await Promise.race([
    dispatched.promise,
    first.then(() => {
      throw new Error('POST was not delivered');
    }),
  ]);
  try {
    const second = await automationClient(config).create(input, { ...identity, callId: 'call-b' });
    assert.equal(second.items[0]?.status, 'blocked');
    assert.equal(second.items[0]?.experimentId, original.experimentId);
    assert.equal(posts, 1);
  } finally {
    finish.resolve();
  }
  assert.equal((await first).items[0]?.status, 'accepted');
});

test('an incomplete successful-looking creation reply does not prove any item was accepted', async (t) => {
  const config = await fixture(t, async (req, res) => {
    const {
      items: [first],
    } = await body(req);
    res.end(
      JSON.stringify({
        items: [
          { experimentId: first!.experimentId, tubeCode: first!.tubeCode, status: 'accepted' },
        ],
      }),
    );
  });
  const result = await automationClient(config).create({ items: combos }, identity);
  assert.equal(result.items.length, 2);
  assert(
    result.items.every((item) => item.status === 'unknown' && item.code === 'INVALID_RESPONSE'),
  );
});
