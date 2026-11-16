import { expect, test } from 'bun:test';
import { SessionTitles } from '../src/lib/session-titles';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('only newly prepared sessions generate once after admission and keep their own target', async () => {
  const writes: unknown[] = [];
  const changed: unknown[] = [];
  const titles = new SessionTitles({
    generate: async (id, content) => {
      expect(id).toBe('new');
      expect(content).toBe('提问');
      return { title: '主题', generation: 'backend' };
    },
    save: async (id, title, generation) => {
      writes.push({ id, title, generation });
      return { id, title };
    },
    changed: (value) => {
      changed.push(value);
    },
  });
  await titles.accepted('historical', '旧问题');
  titles.prepare('new');
  await Promise.all([titles.accepted('new', '提问'), titles.accepted('new', '重复')]);
  await titles.accepted('new', '后续问题');
  expect(writes).toEqual([{ id: 'new', title: '主题', generation: 'backend' }]);
  expect(changed).toEqual([{ id: 'new', title: '主题' }]);
});

test('manual rename and backend reset discard late generated titles', async () => {
  for (const manual of [false, true]) {
    const generation = deferred<{ title: string; generation: string }>();
    const saved: string[] = [];
    const titles = new SessionTitles({
      generate: () => generation.promise,
      save: async (id, title) => {
        saved.push(title);
        return { id, title };
      },
      changed: () => {},
    });
    titles.prepare('session');
    const pending = titles.accepted('session', '提问');
    if (manual) await titles.rename('session', '手动名称');
    else titles.clear();
    generation.resolve({ title: '模型名称', generation: 'old' });
    await pending;
    expect(saved).toEqual(manual ? ['手动名称'] : []);
  }
});

test('manual rename finishes last even when an automatic save is already in flight', async () => {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const saved: string[] = [];
  const titles = new SessionTitles({
    generate: async () => ({ title: '模型名称', generation: 'backend' }),
    save: async (id, title, generation) => {
      if (generation) {
        entered.resolve();
        await gate.promise;
      }
      saved.push(title);
      return { id, title };
    },
    changed: () => {},
  });
  titles.prepare('session');
  const automatic = titles.accepted('session', '提问');
  await entered.promise;
  const manual = titles.rename('session', '手动名称');
  gate.resolve();
  await Promise.all([automatic, manual]);
  expect(saved).toEqual(['模型名称', '手动名称']);
});

test('failed title generation and ambiguous saves are not retried', async () => {
  let saves = 0;
  const titles = new SessionTitles({
    generate: async () => ({ title: '主题', generation: 'backend' }),
    save: async () => {
      saves++;
      throw new Error('Lost response');
    },
    changed: () => {
      throw new Error('Must not publish');
    },
  });
  titles.prepare('session');
  await titles.accepted('session', '提问');
  await titles.accepted('session', '提问');
  expect(saves).toBe(1);
});

test('backend reset invalidates queued manual writes and late receipts without blocking the new identity', async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const saved: string[] = [];
  const changed: string[] = [];
  const titles = new SessionTitles({
    generate: async () => ({ title: '旧自动名称', generation: 'old' }),
    save: async (id, title, generation) => {
      saved.push(title);
      if (generation) {
        entered.resolve();
        await gate.promise;
      }
      return { id, title };
    },
    changed: ({ title }) => {
      changed.push(title);
    },
  });
  titles.prepare('session');
  const automatic = titles.accepted('session', '提问');
  await entered.promise;
  const manual = titles.rename('session', '过期手动名称').then(
    () => 'saved',
    () => 'invalidated',
  );
  titles.clear();
  await titles.rename('session', '新后端名称');
  gate.resolve();
  await automatic;
  expect(await manual).toBe('invalidated');
  expect(saved).toEqual(['旧自动名称', '新后端名称']);
  expect(changed).toEqual(['新后端名称']);
});
