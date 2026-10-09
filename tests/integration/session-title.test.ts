import { test, expect } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skills';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';
import { handler } from '../../src/api';
import type { ModelMessage } from 'ai';
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
    expect(store.getSession(session.id).title).toBe('项目简介');
    expect(events).toContain('session.updated');
    expect(observed.filter((m) => m.role === 'system').length).toBe(2);
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
    expect(store.getSession(session.id).title).toBe('Recovered title');
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
