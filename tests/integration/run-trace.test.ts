import { expect, test } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';
import { handler } from '../../src/api';
import { AppError } from '../../src/shared/types';

test('actual LangGraph topology and prepared prompts persist locally with scoped authenticated reads', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const seen: unknown[] = [];
  let step = 0;
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate(messages, _signal, _text, reasoning) {
      seen.push(messages);
      reasoning?.(++step === 1 ? 'First reasoning.' : 'Second reasoning.');
      return {
        text: step === 1 ? '' : 'Answer',
        toolCalls:
          step === 1 ? [{ id: 'skill-call', name: 'skill', input: { name: 'hello-world' } }] : [],
        usage: { totalTokens: 1 },
      };
    },
  });
  const events: unknown[] = [];
  service.events.subscribe((event) => events.push(event));
  const fetch = handler(service);
  const request = (path: string) =>
    fetch(
      new Request('http://local' + path, {
        headers: { Authorization: `Bearer ${f.config.token}` },
      }),
    );
  try {
    const session = store.createSession();
    await service.submit(session.id, `prompt-marker ${f.config.apiKey}`);
    const runId = store.latestRun(session.id)!.id;
    const path = `/session/${session.id}/runs/${runId}/trace`;
    expect((await fetch(new Request('http://local' + path))).status).toBe(401);
    const trace = await (await request(path)).json();
    expect(trace.graph.nodes).toEqual(
      expect.arrayContaining(['__start__', 'model', 'tools', '__end__']),
    );
    expect(trace.graph.edges).toContainEqual({
      source: 'tools',
      target: 'model',
      conditional: false,
    });
    expect(trace.graph.mermaid).toContain('graph TD');
    expect(trace.nodes.map((node: any) => [node.nodeId, node.status])).toEqual([
      ['model:1', 'completed'],
      ['tool:skill-call', 'completed'],
      ['model:2', 'completed'],
    ]);
    const snapshot = await (await request(path + '?node=model%3A2')).json();
    expect(snapshot.request.payload.messages).toEqual(seen[1]);
    expect(snapshot.request.payload.tools.map((tool: any) => tool.name)).toContain('wiki');
    expect(JSON.stringify(snapshot)).not.toContain(f.config.apiKey!);
    expect(JSON.stringify(snapshot)).toContain('prompt-marker');
    expect(JSON.stringify(events)).not.toContain('prompt-marker');
    expect(await Bun.file(service.diagnostics.paths().agent).text()).not.toContain('prompt-marker');
    const other = store.createSession();
    expect((await request(`/session/${other.id}/runs/${runId}/trace?node=model%3A2`)).status).toBe(
      404,
    );
    const history = await (await request(`/session/${session.id}/message?reasoning=true`)).json();
    expect(history.at(-1).reasoning).toBe('First reasoning.\n\nSecond reasoning.');
    expect(
      (await (await request(`/session/${session.id}/message`)).json()).at(-1).reasoning,
    ).toBeUndefined();
    await service.shutdown();
    store.close();
    const reopened = new Store(f.config.dataDir);
    try {
      expect(reopened.traces.readRequest(session.id, runId, 'model:2')).toEqual(snapshot);
      expect(reopened.messages(session.id, 100, 0, true).at(-1)?.reasoning).toContain(
        'First reasoning.',
      );
    } finally {
      reopened.close();
    }
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('failed requests retain streamed reasoning and an inspectable failed model node', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate(_messages, _signal, _text, reasoning) {
      reasoning?.('Observed partial thought.');
      throw new AppError('model_failure', 'Provider failed');
    },
  });
  try {
    const session = store.createSession();
    await expect(service.submit(session.id, 'request')).rejects.toThrow('Provider failed');
    expect(store.messages(session.id, 100, 0, true).at(-1)?.reasoning).toBe(
      'Observed partial thought.',
    );
    const trace = store.traces.read(session.id, store.latestRun(session.id)!.id);
    expect(trace.nodes[0]).toMatchObject({ status: 'failed', hasRequest: true });
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('oversized inspection snapshots are explicitly marked rather than represented as full requests', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  try {
    const session = store.createSession();
    const runId = store.beginTurn(session.id, 'request');
    store.traces.request(runId, 'model:1', 'model', { text: 'x'.repeat(5 * 1024 * 1024) });
    const saved = store.traces.readRequest(session.id, runId, 'model:1');
    expect(saved).toMatchObject({ truncated: true, reason: 'request_snapshot_limit' });
    expect(saved.request).toBeUndefined();
    expect(saved.preview.length).toBe(65536);
  } finally {
    store.close();
    await f.cleanup();
  }
});
