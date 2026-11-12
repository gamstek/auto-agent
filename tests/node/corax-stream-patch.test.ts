import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { coraxChannel } from '@coraxjs/core/channels/corax';

// Patch-contract test only. Application modules continue to use public Corax APIs.
const helper = pathToFileURL(
  join(
    dirname(fileURLToPath(import.meta.resolve('@coraxjs/core'))),
    'compiled/@workflow/world-local/stream-info-batched.js',
  ),
);
const { inspectStreamInfo } = (await import(helper.href)) as {
  inspectStreamInfo(
    files: string[],
    read: (file: string) => Promise<boolean>,
    concurrency?: number,
  ): Promise<{ tailIndex: number; done: boolean }>;
};
const scopePath = pathToFileURL(
  join(
    dirname(fileURLToPath(import.meta.resolve('@coraxjs/core'))),
    'execution/history-read-scope.js',
  ),
);
const { withHistoryReadScope, readScopedTail } = (await import(scopePath.href)) as {
  withHistoryReadScope<T>(id: string, read: () => T): T;
  readScopedTail<T>(id: string, read: () => Promise<T>): Promise<T>;
};

test('tail scope shares one boundary within a request but never between requests or sessions', async () => {
  let reads = 0;
  const read = async () => ++reads;
  assert.deepEqual(
    await withHistoryReadScope('one', () =>
      Promise.all([readScopedTail('one', read), readScopedTail('one', read)]),
    ),
    [1, 1],
  );
  assert.equal(await withHistoryReadScope('one', () => readScopedTail('one', read)), 2);
  await withHistoryReadScope('one', async () => {
    assert.equal(await readScopedTail('one', read), 3);
    assert.equal(await readScopedTail('other', read), 4);
    assert.equal(await readScopedTail('other', read), 5);
  });
  const parallel = await Promise.all([
    withHistoryReadScope('one', () => readScopedTail('one', read)),
    withHistoryReadScope('one', () => readScopedTail('one', read)),
  ]);
  assert.notEqual(parallel[0], parallel[1]);
});

test('failed tail reads are shared only inside the failed request and a later request can recover', async () => {
  let reads = 0;
  await withHistoryReadScope('one', async () => {
    const fail = async () => {
      reads++;
      throw new Error('read failed');
    };
    const values = await Promise.allSettled([
      readScopedTail('one', fail),
      readScopedTail('one', fail),
    ]);
    assert.equal(reads, 1);
    assert.ok(values.every((value) => value.status === 'rejected'));
  });
  assert.equal(await withHistoryReadScope('one', () => readScopedTail('one', async () => 9)), 9);
});

test('bundled and registry copies share the request carrier without sharing values across requests', async () => {
  const copy = (await import(`${scopePath.href}?bundled-copy`)) as {
    readScopedTail: typeof readScopedTail;
  };
  let reads = 0;
  const read = async () => ++reads;
  await withHistoryReadScope('one', async () => {
    assert.equal(await readScopedTail('one', read), 1);
    assert.equal(await copy.readScopedTail('one', read), 1);
  });
  assert.equal(await copy.readScopedTail('one', read), 2);
});

test('finite HTTP response and stream share a fixed boundary while concurrent appends are deferred', async () => {
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
    (entry) => entry.method === 'GET' && entry.path === '/corax/v1/session/:sessionId/stream',
  );
  assert.ok(route && route.transport !== 'websocket');
  const id = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
  let tail = 9,
    reads = 0;
  const getTail = () =>
    readScopedTail(id, async () => {
      reads++;
      const boundary = tail;
      tail++;
      return boundary;
    });
  const session = {
    id,
    getStreamTailIndex: getTail,
    async getEventStream(options: { follow: boolean; startIndex?: number }) {
      const boundary = await getTail();
      const start =
        (options.startIndex ?? 0) < 0
          ? Math.max(0, boundary + 1 + options.startIndex!)
          : (options.startIndex ?? 0);
      return new ReadableStream({
        start(controller) {
          for (let index = start; index <= boundary; index++)
            controller.enqueue({ type: 'message.received', data: { fixtureIndex: index } });
          controller.close();
        },
      });
    },
  };
  const context = {
    params: { sessionId: id },
    attachSession: () => session,
  } as unknown as Parameters<typeof route.handler>[1];
  const response = await route.handler(
    new Request(`http://localhost/corax/v1/session/${id}/stream?startIndex=-3&follow=false`),
    context,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-corax-stream-tail-index'), '9');
  assert.deepEqual(
    (await response.text())
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line).data.fixtureIndex),
    [7, 8, 9],
  );
  assert.equal(reads, 1);
  const next = await route.handler(
    new Request(`http://localhost/corax/v1/session/${id}/stream?startIndex=11&follow=false`),
    context,
  );
  assert.equal(next.headers.get('x-corax-stream-tail-index'), '10');
  assert.equal((await next.text()).trim(), '');
  assert.equal(reads, 2);
  const live = await route.handler(
    new Request(`http://localhost/corax/v1/session/${id}/stream?startIndex=11`),
    context,
  );
  await live.text();
  assert.equal(reads, 4, 'a live subscription must retain its original independent tail lookups');
  tail = -1;
  const empty = await route.handler(
    new Request(`http://localhost/corax/v1/session/${id}/stream?startIndex=-512&follow=false`),
    context,
  );
  assert.equal(empty.headers.get('x-corax-stream-tail-index'), '-1');
  assert.equal((await empty.text()).trim(), '');
  assert.equal(reads, 5);
});

test('patched stream inspection preserves empty, open and first-EOF boundaries', async () => {
  for (const length of [0, 1, 31, 32, 33, 129]) {
    const files = Array.from({ length }, (_, index) => String(index));
    for (const eof of [-1, 0, 30, 32, length - 1]) {
      const result = await inspectStreamInfo(files, async (file) => Number(file) === eof);
      const found = eof >= 0 && eof < length;
      assert.deepEqual(result, { tailIndex: found ? eof - 1 : length - 1, done: found });
    }
  }
});

test('parallel completion order cannot change the first error or EOF boundary', async () => {
  const files = Array.from({ length: 70 }, (_, index) => String(index));
  const expected = new Error('first failing chunk');
  await assert.rejects(
    inspectStreamInfo(files, async (file) => {
      const index = Number(file);
      if (index === 2) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw expected;
      }
      if (index === 7) throw new Error('later failure');
      return index === 8;
    }),
    (error) => error === expected,
  );
  assert.deepEqual(
    await inspectStreamInfo(files, async (file) => {
      const index = Number(file);
      if (index === 2) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return true;
      }
      if (index > 2) throw new Error('inaccessible data after EOF');
      return false;
    }),
    { tailIndex: 1, done: true },
  );
});

test('chunk inspection keeps a bounded number of open operations and drains them before returning', async () => {
  let active = 0,
    maximum = 0;
  const files = Array.from({ length: 260 }, (_, index) => String(index));
  const result = await inspectStreamInfo(files, async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return false;
  });
  assert.equal(maximum, 32);
  assert.equal(active, 0);
  assert.deepEqual(result, { tailIndex: 259, done: false });
  await assert.rejects(
    inspectStreamInfo(files, async () => false, 0),
    RangeError,
  );
  await assert.rejects(
    inspectStreamInfo(files, async () => false, 65),
    RangeError,
  );
});

test('patched local-world integration preserves append, closed-stream and post-EOF semantics on disk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corax-stream-patch-'));
  try {
    const { createWorld } = await import(new URL('./index.js', helper).href);
    const world = createWorld({ dataDir: directory, recoverActiveRuns: false });
    const run = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    const stream = 'patch-fixture';
    assert.deepEqual(await world.streams.getInfo(run, stream), { tailIndex: -1, done: false });
    await world.streams.writeMulti(
      run,
      stream,
      Array.from({ length: 65 }, (_, index) => `fixture-${index}`),
    );
    assert.deepEqual(await world.streams.getInfo(run, stream), { tailIndex: 64, done: false });
    await world.streams.write(run, stream, 'last-payload');
    assert.deepEqual(await world.streams.getInfo(run, stream), { tailIndex: 65, done: false });
    await world.streams.close(run, stream);
    assert.deepEqual(await world.streams.getInfo(run, stream), { tailIndex: 65, done: true });
    // The original reader stops at the FIRST EOF even if another writer appended.
    await world.streams.write(run, stream, 'after-eof');
    assert.deepEqual(await world.streams.getInfo(run, stream), { tailIndex: 65, done: true });
    const later = createWorld({ dataDir: directory, recoverActiveRuns: false });
    assert.deepEqual(await later.streams.getInfo(run, stream), { tailIndex: 65, done: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
