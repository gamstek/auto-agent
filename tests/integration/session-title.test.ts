import { test, expect } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';
import { handler } from '../../src/api';
import type { ModelMessage } from 'ai';

async function waitForTitle(store: Store, id: string, title: string) {
  for (let i = 0; i < 100 && store.getSession(id).title !== title; i++) await Bun.sleep(1);
  expect(store.getSession(id).title).toBe(title);
}
test('model titles persist, preserve custom titles, and custom prompt augments platform instructions', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  f.config.systemPrompt = 'Answer concisely in Chinese.';
  let titles = 0;
  let observed: ModelMessage[] = [];
  const model = {
    async generate(messages: ModelMessage[]) {
      observed = messages;
      return { text: '你好', toolCalls: [], totalTokens: 1 };
    },
    async generateTitle(messages: ModelMessage[]) {
      titles++;
      expect(messages[0].content).toBe('介绍项目');
      return '项目简介';
    },
  };
  const service = new AgentService(
    f.config,
    store,
    skills,
    new ScriptExecutor(f.config, skills),
    model,
  );
  const events: string[] = [];
  service.events.subscribe((e) => events.push(e.type));
  try {
    const session = store.createSession();
    await service.submit(session.id, '介绍项目');
    await waitForTitle(store, session.id, '项目简介');
    expect(events).toContain('session.updated');
    expect(observed.filter((m) => m.role === 'system').length).toBe(3);
    expect(observed[0].content).toContain('You are Auto-Agent');
    expect(observed[1].content).toBe(f.config.systemPrompt!);
    await service.submit(session.id, '继续');
    expect(titles).toBe(1);
    const manual = store.createSession('My title');
    await service.submit(manual.id, '介绍项目');
    expect(store.getSession(manual.id).title).toBe('My title');
    expect(titles).toBe(1);
    const response = await handler(service)(
      new Request('http://localhost/session', {
        headers: { Authorization: 'Bearer ' + f.config.token },
      }),
    );
    expect((await response.json()).find((s: { id: string }) => s.id === session.id).title).toBe(
      '项目简介',
    );
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
test('pending titles do not block completion, abort or concurrency; shutdown cancels titles', async () => {
  const f = await fixture();
  f.config.maxConcurrent = 1;
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  let titleSignal: AbortSignal | undefined;
  let titleCalls = 0;
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      return { text: 'answer', toolCalls: [], totalTokens: 1 };
    },
    async generateTitle(_messages, signal) {
      titleSignal = signal;
      titleCalls++;
      return new Promise<string>(() => {});
    },
  });
  const events: string[] = [];
  let completionAbort: Promise<boolean> | undefined;
  service.events.subscribe((e) => {
    events.push(e.type);
    if (e.type === 'message.completed') completionAbort = service.abort(e.sessionId);
  });
  try {
    const session = store.createSession();
    expect((await service.submit(session.id, 'hello')).content).toBe('answer');
    expect(await completionAbort).toBe(false);
    expect(await service.abort(session.id)).toBe(false);
    expect(store.db.query('SELECT status FROM runs').get()).toEqual({ status: 'completed' });
    expect(events.indexOf('message.completed')).toBeLessThan(
      events.indexOf('session.title.started'),
    );
    expect(titleSignal?.aborted).toBe(false);
    await service.submit(session.id, 'again');
    await service.submit(store.createSession().id, 'other');
    expect(titleCalls).toBe(1);
    await service.shutdown();
    expect(titleSignal?.aborted).toBe(true);
    expect(store.messages(session.id)).toHaveLength(4);
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('title timeout ignores late results and permits a later retry', async () => {
  const f = await fixture();
  f.config.modelTimeoutMs = 20;
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  let resolveTitle: (title: string) => void = () => {};
  let attempts = 0;
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      return { text: 'answer', toolCalls: [], totalTokens: 1 };
    },
    async generateTitle() {
      if (++attempts === 1)
        return new Promise<string>((resolve) => {
          resolveTitle = resolve;
        });
      return 'Retry title';
    },
  });
  try {
    const session = store.createSession();
    await service.submit(session.id, 'hello');
    await Bun.sleep(40);
    resolveTitle('Late title');
    await Bun.sleep(1);
    expect(store.getSession(session.id).title).toBe('New session');
    await service.submit(session.id, 'again');
    await waitForTitle(store, session.id, 'Retry title');
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('title failure does not fail replies and is retried on subsequent messages', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  let attempts = 0;
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      return { text: 'answer', toolCalls: [], totalTokens: 1 };
    },
    async generateTitle() {
      if (++attempts === 1) throw new Error('provider secret');
      return 'Recovered title';
    },
  });
  try {
    const session = store.createSession();
    expect((await service.submit(session.id, 'hello')).content).toBe('answer');
    expect(store.getSession(session.id).title).toBe('New session');
    await service.submit(session.id, 'again');
    await waitForTitle(store, session.id, 'Recovered title');
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
