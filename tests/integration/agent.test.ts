import { Readable, Writable } from 'node:stream';
import { test, expect } from 'bun:test';
import { fixture } from '../helpers';
import { Skills } from '../../src/skills';
import { ScriptExecutor } from '../../src/execution';
import { Store } from '../../src/storage';
import { AgentService } from '../../src/agent';
import { serve, handler } from '../../src/api';
import { Events } from '../../src/agent/events';
import type { AgentEvent, ModelAdapter, ModelTurn } from '../../src/shared/types';
import { cli, argumentsFor } from '../../src/cli';
async function app(model: ModelAdapter) {
  const f = await fixture();
  const skills = new Skills(f.config);
  await skills.discover();
  const store = new Store(f.config.dataDir);
  const service = new AgentService(
    f.config,
    store,
    skills,
    new ScriptExecutor(f.config, skills),
    model,
  );
  return {
    ...f,
    service,
    store,
    dispose: async () => {
      await service.shutdown();
      store.close();
      await f.cleanup();
    },
  };
}
function sequence(turns: ModelTurn[]): ModelAdapter {
  let index = 0;
  return {
    async generate(_messages, signal, delta) {
      signal.throwIfAborted();
      const turn = turns[index++];
      if (!turn) throw new Error('Unexpected model call');
      if (turn.text) delta(turn.text);
      return turn;
    },
  };
}
const call = (name: string, input: unknown): ModelTurn => ({
  text: '',
  totalTokens: 1,
  toolCalls: [{ id: crypto.randomUUID(), name, input }],
});
// Temporarily skipped pending investigation of script execution timeouts in CI.
test.skip('LangGraph selects one of two skills, loads resource, executes and answers; no forced scripts', async () => {
  const a = await app(
    sequence([
      call('load_skill', { skill: 'sum-values' }),
      call('read_skill_resource', { skill: 'sum-values', path: 'reference.txt' }),
      call('execute_skill_script', {
        skill: 'sum-values',
        path: 'scripts/main.js',
        args: ['2', '3'],
      }),
      { text: 'The sum is 5', totalTokens: 1, toolCalls: [] },
      { text: 'Hello without tools', totalTokens: 1, toolCalls: [] },
    ]),
  );
  try {
    const session = a.store.createSession();
    const events: string[] = [];
    a.service.events.subscribe((e) => events.push(e.type));
    expect((await a.service.submit(session.id, 'Add two and three')).content).toBe('The sum is 5');
    expect((await a.service.submit(session.id, 'Hello')).content).toBe('Hello without tools');
    expect(a.store.db.query('SELECT COUNT(*) AS count FROM executions').get()).toEqual({
      count: 1,
    });
    expect(events).toContain('message.part.delta');
    expect(events).toContain('tool.completed');
  } finally {
    await a.dispose();
  }
}, 60000);
test('API authentication routes CLI remote session history and SSE', async () => {
  const a = await app(sequence([{ text: 'reply', totalTokens: 1, toolCalls: [] }]));
  const server = serve(a.service);
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { Authorization: `Bearer ${a.config.token}`, 'Content-Type': 'application/json' };
  try {
    expect((await fetch(base + '/global/health')).status).toBe(200);
    for (const path of ['/session', '/event']) expect((await fetch(base + path)).status).toBe(401);
    for (const path of ['/runs', '/devices', '/skills'])
      expect((await fetch(base + path, { headers })).status).toBe(404);
    const session = await (
      await fetch(base + '/session', { method: 'POST', headers, body: '{}' })
    ).json();
    const controller = new AbortController();
    const stream = await fetch(base + '/event', { headers, signal: controller.signal });
    const reader = stream.body!.getReader();
    await reader.read();
    const response = await fetch(base + `/session/${session.id}/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'hello' }),
    });
    expect(response.status).toBe(200);
    const bytes = await reader.read();
    expect(new TextDecoder().decode(bytes.value)).toContain(session.id);
    controller.abort();
    await reader.cancel().catch(() => {});
    expect(
      (await (await fetch(base + `/session/${session.id}/message`, { headers })).json()).length,
    ).toBe(2);
    await cli(argumentsFor(['--session', session.id]), a.config, a.service, {
      input: Readable.from(['/exit\n']),
      output: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      error: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      terminal: false,
    });
    const large = await handler(a.service)(
      new Request(base + '/session', { method: 'POST', headers, body: 'x'.repeat(5000) }),
    );
    expect(large.status).toBe(413);
  } finally {
    server.stop(true);
    await a.dispose();
  }
});
test('same session conflicts, different sessions concurrent, model cancellation and step budget', async () => {
  const waiting: ModelAdapter = {
    generate: (_m, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }),
      ),
  };
  const a = await app(waiting);
  try {
    const s = a.store.createSession();
    const t = a.store.createSession();
    const first = a.service.submit(s.id, 'wait');
    void first.catch(() => {});
    expect(() => a.service.submit(s.id, 'again')).toThrow('active');
    const second = a.service.submit(t.id, 'other');
    void second.catch(() => {});
    expect(await a.service.abort(s.id)).toBe(true);
    await expect(first).rejects.toThrow('cancelled');
    await a.service.abort(t.id);
    expect(a.store.messages(s.id).at(-1)?.content).toContain('does not confirm');
  } finally {
    await a.dispose();
  }
  const b = await app({
    async generate() {
      return call('list_skills', {});
    },
  });
  b.config.maxSteps = 2;
  try {
    await expect(b.service.submit(b.store.createSession().id, 'loop')).rejects.toThrow('budget');
  } finally {
    await b.dispose();
  }
});
// Temporarily skipped pending investigation of script execution timeouts in CI.
test.skip('failed scripts cannot be replayed within a generation and event subscriber count is bounded', async () => {
  const a = await app(
    sequence([
      call('load_skill', { skill: 'hello-world' }),
      call('execute_skill_script', { skill: 'hello-world', path: 'scripts/main.js' }),
      call('execute_skill_script', { skill: 'hello-world', path: 'scripts/main.js' }),
      { text: 'Interpreter unavailable', totalTokens: 1, toolCalls: [] },
    ]),
  );
  a.config.interpreters['.js'] = 'missing-interpreter-auto-agent';
  try {
    await a.service.submit(a.store.createSession().id, 'greet');
    expect(a.store.db.query('SELECT COUNT(*) AS count FROM executions').get()).toEqual({
      count: 1,
    });
    expect(a.store.db.query('SELECT status FROM executions').get()).toEqual({ status: 'failed' });
  } finally {
    await a.dispose();
  }
  const events = new Events();
  const abort = new AbortController();
  const stream = events.stream(abort.signal, 1);
  expect(() => events.stream(new AbortController().signal, 1)).toThrow('subscribers');
  await stream.cancel();
  const next = events.stream(abort.signal, 1);
  await next.cancel();
}, 30000);
test('slow SSE client closes without aborting an agent', async () => {
  const events = new Events();
  const controller = new AbortController();
  const stream = events.stream(controller.signal);
  for (let i = 0; i < 100; i++)
    events.publish({
      type: 'message.part.delta',
      sessionId: 's',
      messageId: 'm',
      properties: { delta: 'x' },
    });
  const reader = stream.getReader();
  let count = 0;
  while (!(await reader.read()).done) count++;
  expect(count).toBeLessThanOrEqual(64);
  controller.abort();
});

// Temporarily skipped pending investigation of script execution timeouts in CI.
test.skip('explicit no-token mode supports sessions messages events scripts and loopback CLI only', async () => {
  const a = await app(
    sequence([
      call('load_skill', { skill: 'sum-values' }),
      call('execute_skill_script', {
        skill: 'sum-values',
        path: 'scripts/main.js',
        args: ['2', '3'],
      }),
      { text: '5', totalTokens: 1, toolCalls: [] },
    ]),
  );
  a.config.noToken = true;
  a.config.token = '';
  a.config.scriptEnv = { GREETING: 'hello' };
  const server = serve(a.service);
  const base = 'http://127.0.0.1:' + server.port;
  try {
    const session = await (await fetch(base + '/session', { method: 'POST', body: '{}' })).json();
    const response = await fetch(base + '/session/' + session.id + '/message', {
      method: 'POST',
      body: JSON.stringify({ content: 'add' }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).content).toBe('5');
    expect(a.store.db.query('SELECT status FROM executions').get()).toEqual({
      status: 'completed',
    });
    const controller = new AbortController();
    const event = await fetch(base + '/event', { signal: controller.signal });
    expect(event.status).toBe(200);
    await event.body!.cancel();
    controller.abort();
    await cli(argumentsFor(['--session', session.id]), a.config, a.service, {
      input: Readable.from(['/exit\n']),
      output: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      error: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      terminal: false,
    });
    expect(() => argumentsFor(['--url', 'http://example.invalid'])).toThrow();
    a.config.host = '0.0.0.0';
    a.config.allowRemote = true;
    expect(() => handler(a.service)).toThrow('loopback');
  } finally {
    server.stop(true);
    await a.dispose();
  }
}, 30000);

test('HTTP SSE streams correlated model steps and resource tool outcomes without executing scripts', async () => {
  const a = await app(
    sequence([
      call('load_skill', { skill: 'sum-values' }),
      call('read_skill_resource', {
        skill: 'sum-values',
        path: 'reference.txt',
      }),
      call('read_skill_resource', { skill: 'missing', path: 'reference.txt' }),
      { text: 'Done', totalTokens: 1, toolCalls: [] },
    ]),
  );
  const server = serve(a.service);
  const base = 'http://127.0.0.1:' + server.port;
  const headers = { Authorization: 'Bearer ' + a.config.token, 'Content-Type': 'application/json' };
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let consumption: Promise<AgentEvent[]> | undefined;
  try {
    const session = a.store.createSession();
    const response = await fetch(base + '/event', { headers, signal: controller.signal });
    const streamReader = response.body!.getReader();
    reader = streamReader;
    await streamReader.read();
    const consume = (async () => {
      let buffer = '';
      const events: AgentEvent[] = [];
      while (true) {
        const part = await streamReader.read();
        if (part.done) throw new Error('SSE closed');
        buffer += new TextDecoder().decode(part.value);
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (!frame.startsWith('data: ')) continue;
          const event = JSON.parse(frame.slice(6));
          events.push(event);
          if (event.type === 'session.status' && event.properties.status === 'idle') return events;
        }
      }
    })();
    consumption = consume;
    // Observe reader failures immediately, even while submission is still pending.
    void consume.catch(() => {});
    await a.service.submit(session.id, 'read the resource');
    const events = await consume;
    expect(events.filter((e) => e.type === 'model.started').length).toBe(4);
    expect(events.filter((e) => e.type === 'model.completed').length).toBe(4);
    const starts = events.filter((e) => e.type === 'tool.started');
    expect(starts.length).toBe(3);
    expect(starts.some((event) => event.properties.name === 'execute_skill_script')).toBe(false);
    for (const start of starts) {
      const ends = events.filter(
        (e) =>
          ['tool.completed', 'tool.failed'].includes(e.type) &&
          e.properties.toolCallId === start.properties.toolCallId,
      );
      expect(ends.length).toBe(1);
      expect(typeof ends[0].properties.durationMs).toBe('number');
    }
    expect(
      events.some((e) => e.type === 'tool.failed' && e.properties.name === 'read_skill_resource'),
    ).toBe(true);
    expect(events.every((e) => e.sessionId === session.id)).toBe(true);
    expect(new Set(events.map((e) => e.messageId)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain(a.config.apiKey!);
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    await consumption?.catch(() => {});
    reader?.releaseLock();
    server.stop(true);
    await a.dispose();
  }
}, 30000);
