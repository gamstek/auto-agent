import { expect, test } from 'bun:test';
import {
  KnowledgeOperations,
  knowledgeOperations,
  knowledgeSnapshot,
} from '../../corax/lib/wiki/desktop';
import type { KnowledgeReport } from '../../corax/lib/wiki/ingest';
import { configSchema } from 'auto-agent/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('explicit compiler operations retain partial publications and never restart on cancellation', async () => {
  const operations = new KnowledgeOperations();
  let calls = 0;
  let finish!: (value: KnowledgeReport) => void;
  let aborted = false;
  const operation = operations.start('first', async (signal, progress) => {
    calls++;
    signal.addEventListener('abort', () => {
      aborted = true;
    });
    progress({ phase: 'analysis', total: 2, completed: 0, source: 'local/source.md' });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await Bun.sleep(0);
  expect(operations.snapshot()).toMatchObject({ state: 'running', phase: 'analysis', total: 2 });
  expect(
    operations.start('first', async () => {
      throw new Error('must not replay');
    }),
  ).toBe(operation);
  expect(() =>
    operations.start('second', async () => {
      throw new Error('must not overlap');
    }),
  ).toThrow();
  operations.cancel('first');
  expect(aborted).toBe(true);
  expect(operations.snapshot()?.state).toBe('cancelling');
  finish({
    status: 'cancelled',
    completed: [
      {
        source: 'local/first.md',
        reused: false,
        generation: 'fixture',
        pages: ['concepts/first.md'],
      },
    ],
    ignored: [],
    ignoredCount: 0,
    ignoredTruncated: false,
  });
  await operation.done;
  expect(operations.snapshot()).toMatchObject({
    state: 'cancelled',
    completed: 1,
    total: 2,
    pageCount: 1,
  });
  expect(calls).toBe(1);
  expect(() => operations.cancel('different')).toThrow();
});

test('compiler failures are surfaced and do not automatically call the model again', async () => {
  const operations = new KnowledgeOperations();
  let calls = 0;
  const operation = operations.start('failed', async () => {
    calls++;
    throw new Error('local failure');
  });
  await operation.done;
  expect(operations.snapshot()).toMatchObject({
    state: 'failed',
    completed: 0,
    message: 'local failure',
  });
  expect(calls).toBe(1);
});

test('bounded progress and failure metadata keep Unicode filenames valid for native JSON parsing', async () => {
  const operations = new KnowledgeOperations();
  const source = 'x'.repeat(239) + '🔬remaining';
  const operation = operations.start('unicode', async (_signal, progress) => {
    progress({ phase: 'analysis', total: 1, completed: 0, source });
    expect(/[\uD800-\uDFFF]/u.test(operations.snapshot()!.source!)).toBe(false);
    return {
      status: 'failed',
      completed: [],
      ignored: [],
      ignoredCount: 0,
      ignoredTruncated: false,
      failedSource: source,
      message: 'x'.repeat(1599) + '🔬remaining',
    };
  });
  await operation.done;
  expect(/[\uD800-\uDFFF]/u.test(operations.snapshot()!.failedSource!)).toBe(false);
  expect(/[\uD800-\uDFFF]/u.test(operations.snapshot()!.message!)).toBe(false);
});

test('a status read begun during compilation stays pollable when the operation finishes during the read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'auto-agent-knowledge-snapshot-'));
  let finish!: (report: KnowledgeReport) => void;
  const operation = knowledgeOperations.start(
    'snapshot-race',
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    await Bun.sleep(0);
    const reading = knowledgeSnapshot(configSchema.parse({ dataDir: directory }));
    finish({
      status: 'completed',
      completed: [],
      ignored: [],
      ignoredCount: 0,
      ignoredTruncated: false,
    });
    await operation.done;
    expect((await reading).operation?.state).toBe('running');
    expect(knowledgeOperations.snapshot()?.state).toBe('completed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
