import { expect, test, spyOn } from 'bun:test';
import { AgentService } from '../../src/agent';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { fixture } from '../helpers';
import { requireTokenUsage } from '../../src/shared/types';

test('SDK-reported usage rejects missing, invalid and inconsistent counts without estimating', () => {
  for (const usage of [
    {},
    { totalTokens: NaN },
    { totalTokens: Infinity },
    { totalTokens: -1 },
    { totalTokens: 1.5 },
    { totalTokens: Number.MAX_SAFE_INTEGER + 1 },
    { totalTokens: 3, inputTokens: -1 },
    { totalTokens: 3, outputTokens: NaN },
    { totalTokens: 3, inputTokens: 1, outputTokens: 1 },
  ])
    expect(() => requireTokenUsage(usage)).toThrow('valid token usage');
  expect(requireTokenUsage({ totalTokens: 3 })).toBe(3);
  expect(requireTokenUsage({ totalTokens: 3, inputTokens: 2, outputTokens: 1 })).toBe(3);
  expect(requireTokenUsage({ totalTokens: 0, inputTokens: 0, outputTokens: 0 })).toBe(0);
});

test('an adapter with invalid usage cannot execute pending tools', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const load = spyOn(skills, 'load');
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      return {
        text: '',
        usage: {
          totalTokens: NaN,
        },
        toolCalls: [{ id: 'pending', name: 'skill', input: { name: 'hello-world' } }],
      };
    },
  });
  const events: string[] = [];
  service.events.subscribe((event) => events.push(event.type));
  try {
    await expect(service.submit(store.createSession().id, 'Run')).rejects.toThrow(
      'valid token usage',
    );
    expect(load).not.toHaveBeenCalled();
    expect(events).toContain('model.failed');
    expect(events).not.toContain('model.completed');
    expect(events).not.toContain('tool.started');
    expect(store.db.query('SELECT status FROM runs').get()).toEqual({ status: 'failed' });
  } finally {
    load.mockRestore();
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('long workflows report repeated SDK input usage without a cumulative run limit', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const totals = [3000, 4352, 6580, 7381, 7761, 8050, 700];
  let step = 0;
  const events: any[] = [];
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      const current = step++;
      return {
        text: current === totals.length - 1 ? 'Finished workflow' : '',
        usage: {
          totalTokens: totals[current]!,
          inputTokens: totals[current]! - 50,
          outputTokens: 50,
        },
        toolCalls:
          current === totals.length - 1
            ? []
            : [
                {
                  id: String(current),
                  name: current === 0 ? 'skill' : 'read',
                  input:
                    current === 0
                      ? { name: 'hello-world' }
                      : { skill: 'hello-world', path: 'reference.txt' },
                },
              ],
      };
    },
  });
  service.events.subscribe((event) => events.push(event));
  try {
    expect((await service.submit(store.createSession().id, 'Perform the workflow')).content).toBe(
      'Finished workflow',
    );
    const completed = events.filter((event) => event.type === 'model.completed');
    expect(completed.at(-1).properties.runTokens).toBe(
      totals.reduce((sum, value) => sum + value, 0),
    );
    expect(completed.at(-1).properties).not.toHaveProperty('maxTokens');
    expect(completed[1].properties.inputTokens).toBe(4302);
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('high cumulative SDK usage does not impose an unrelated per-run token limit', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      return {
        text: 'Done',
        usage: { totalTokens: 33000, inputTokens: 32000, outputTokens: 1000 },
        toolCalls: [],
      };
    },
  });
  try {
    expect((await service.submit(store.createSession().id, 'Run')).content).toBe('Done');
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
