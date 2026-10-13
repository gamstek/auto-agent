import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { estimatedTokens, fitModelContext } from '../../src/agent/context';
import { AgentService } from '../../src/agent';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { fixture } from '../helpers';

const usage = { inputTokens: 8, outputTokens: 2, totalTokens: 10 };
const history = (): ModelMessage[] => [
  { role: 'system', content: 'Critical system rules' },
  ...Array.from({ length: 8 }, (_, index) => ({
    role: 'user' as const,
    content: `Past ${index}: ${'data '.repeat(100)}`,
  })),
  { role: 'user', content: 'Current request must remain intact' },
];

test('summary requests respect input capacity and previous summaries can be compressed again', async () => {
  const requests: ModelMessage[][] = [];
  const summaries: number[] = [];
  const options = {
    signal: new AbortController().signal,
    async summarize(messages: ModelMessage[]) {
      expect(estimatedTokens(messages)).toBeLessThanOrEqual(800);
      requests.push(messages);
      return { text: 'Observed historical identifiers and unresolved state.', usage };
    },
    onSummary(details: { totalTokens: number }) {
      summaries.push(details.totalTokens);
    },
  };
  const result = await fitModelContext(history(), 800, 100, options);
  expect(requests.length).toBeGreaterThan(1);
  expect(result.estimatedTokens).toBeLessThanOrEqual(800);
  expect(JSON.stringify(result.messages)).toContain('Current request must remain intact');
  expect(JSON.stringify(result.messages)).toContain('Critical system rules');
  expect(result.messages.filter((message) => message.role === 'system')).toHaveLength(1);
  expect(summaries).toEqual(requests.map(() => 10));
  const next = [
    ...result.messages,
    ...history().slice(1, -1),
    { role: 'user' as const, content: 'New current request' },
  ];
  requests.length = 0;
  const recompressed = await fitModelContext(next, 800, 100, options);
  expect(JSON.stringify(requests)).toContain('Observed historical identifiers');
  expect(JSON.stringify(recompressed.messages)).toContain('New current request');
});

test('near-limit context remains valid when optional summarization is unavailable', async () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'x'.repeat(2730) }];
  const size = estimatedTokens(messages);
  expect(size).toBeGreaterThanOrEqual(900);
  expect(size).toBeLessThanOrEqual(1000);
  expect(await fitModelContext(messages, 1000)).toEqual({
    messages,
    estimatedTokens: size,
    removedMessages: 0,
  });
});

test('failed, invalid or oversized summaries never silently discard historical data', async () => {
  const messages = history();
  const before = JSON.stringify(messages);
  await expect(fitModelContext(messages, 800)).rejects.toThrow('summarize support');
  for (const summary of [
    { text: '', usage },
    { text: 'Summary', usage: {} },
    { text: 'Summary'.repeat(1000), usage },
  ]) {
    await expect(
      fitModelContext(messages, 800, 0, {
        signal: new AbortController().signal,
        summarize: async () => summary,
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(messages)).toBe(before);
  }
  await expect(
    fitModelContext(messages, 800, 0, {
      signal: new AbortController().signal,
      summarize: async () => {
        throw new Error('Summary unavailable');
      },
    }),
  ).rejects.toThrow('Summary unavailable');
  await expect(
    fitModelContext(
      [
        { role: 'user', content: 'One large historical group'.repeat(1000) },
        { role: 'user', content: 'Current' },
      ],
      800,
      0,
      {
        signal: new AbortController().signal,
        summarize: async () => ({ text: 'Summary', usage }),
      },
    ),
  ).rejects.toThrow('complete historical');
});

test('cancellation stops an in-flight summary even if an adapter ignores the signal', async () => {
  const controller = new AbortController();
  const pending = fitModelContext(history(), 800, 0, {
    signal: controller.signal,
    summarize: () => new Promise(() => {}),
  });
  controller.abort();
  await expect(pending).rejects.toThrow('cancelled');
});

test('agent counts summary usage and reuses the compressed messages in subsequent model steps', async () => {
  const f = await fixture();
  f.config.maxInputTokens = 4200;
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const session = store.createSession();
  for (let index = 0; index < 10; index++)
    store.addMessage(session.id, 'user', `Old ${index}: ${'history '.repeat(120)}`);
  let summaries = 0,
    steps = 0;
  const events: any[] = [];
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async summarize(messages) {
      summaries++;
      expect(estimatedTokens(messages)).toBeLessThanOrEqual(f.config.maxInputTokens);
      return { text: 'Old requests remain unresolved.', usage };
    },
    async generate(messages) {
      expect(JSON.stringify(messages)).toContain('Old requests remain unresolved');
      expect(JSON.stringify(messages)).toContain('Current workflow');
      return {
        text: steps++ ? 'Done' : '',
        usage: { totalTokens: 1 },
        toolCalls:
          steps === 1 ? [{ id: 'load', name: 'skill', input: { name: 'hello-world' } }] : [],
      };
    },
  });
  service.events.subscribe((event) => events.push(event));
  try {
    expect((await service.submit(session.id, 'Current workflow')).content).toBe('Done');
    expect(summaries).toBeGreaterThan(0);
    expect(events.filter((event) => event.type === 'context.compressed')).toHaveLength(summaries);
    expect(
      events.filter((event) => event.type === 'model.completed').at(-1).properties.runTokens,
    ).toBe(summaries * 10 + 2);
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
