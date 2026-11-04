import { expect, spyOn, test } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { AgentService } from '../../src/agent';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { AppError, type ModelAdapter } from '../../src/shared/types';

async function setup(model: ModelAdapter) {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const service = new AgentService(
    f.config,
    store,
    skills,
    new ScriptExecutor(f.config, skills),
    model,
  );
  return {
    f,
    store,
    skills,
    service,
    async close() {
      await service.shutdown();
      store.close();
      await f.cleanup();
    },
  };
}

test('terminal reply and run status commit atomically', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  try {
    const session = store.createSession();
    const run = store.beginTurn(session.id, 'request');
    const finish = spyOn(store, 'finishRun').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    try {
      expect(() =>
        store.completeRun(run, session.id, 'reply', { text: 'answer', reasoning: 'reason' }),
      ).toThrow();
      expect(store.messages(session.id)).toHaveLength(1);
      expect(store.latestRun(session.id)?.status).toBe('running');
      expect(store.db.query('SELECT count(*) AS n FROM message_reasoning').get()).toEqual({ n: 0 });
    } finally {
      finish.mockRestore();
    }
    store.completeRun(run, session.id, 'reply', { text: 'answer' });
    expect(store.messages(session.id)).toHaveLength(2);
    expect(store.latestRun(session.id)?.status).toBe('completed');
  } finally {
    store.close();
    await f.cleanup();
  }
});

test('incomplete model responses never dispatch tool calls', async () => {
  const s = await setup({
    async generate() {
      return {
        text: 'partial',
        toolCalls: [{ id: 'load', name: 'skill', input: { name: 'hello-world' } }],
        usage: { totalTokens: 1 },
        finishReason: 'length',
      };
    },
  });
  const events: string[] = [];
  s.service.events.subscribe((event) => events.push(event.type));
  try {
    await expect(s.service.submit(s.store.createSession().id, 'request')).rejects.toThrow(
      'dependent tools were not executed',
    );
    expect(events).not.toContain('tool.started');
  } finally {
    await s.close();
  }
});

test('cross-turn evidence records observations without carrying loaded skill instructions', async () => {
  let step = 0;
  let historical: unknown[] = [];
  let nextResult = '';
  const s = await setup({
    async generate(messages) {
      if (++step === 1)
        return {
          text: '',
          toolCalls: [{ id: 'load', name: 'skill', input: { name: 'hello-world' } }],
          usage: { totalTokens: 1 },
        };
      if (step === 3) {
        historical = messages.filter(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('Recorded tool evidence'),
        );
        return {
          text: '',
          toolCalls: [
            { id: 'read', name: 'read', input: { skill: 'hello-world', path: 'SKILL.md' } },
          ],
          usage: { totalTokens: 1 },
        };
      }
      if (step === 4) nextResult = JSON.stringify(messages);
      return { text: 'answer', toolCalls: [], usage: { totalTokens: 1 } };
    },
  });
  try {
    const session = s.store.createSession();
    await s.service.submit(session.id, 'first');
    await s.service.submit(session.id, 'next');
    expect(step).toBe(4);
    expect(historical).toHaveLength(1);
    expect(JSON.stringify(historical)).toContain('\\"toolCallId\\":\\"load\\"');
    expect(JSON.stringify(historical)).toContain('\\"status\\":\\"completed\\"');
    expect(JSON.stringify(historical)).not.toContain('Follow');
    expect(nextResult).toContain('skill_not_loaded');
  } finally {
    await s.close();
  }
});

test('evidence storage failure stops dependent execution and preserves a failed terminal reply', async () => {
  const s = await setup({
    async generate() {
      return {
        text: '',
        toolCalls: [
          { id: 'one', name: 'skill', input: { name: 'hello-world' } },
          { id: 'two', name: 'read', input: { skill: 'hello-world', path: 'SKILL.md' } },
        ],
        usage: { totalTokens: 1 },
      };
    },
  });
  const record = spyOn(s.store, 'recordToolEvidence').mockImplementation(() => {
    throw new Error('disk');
  });
  const calls: unknown[] = [];
  s.service.events.subscribe((event) => {
    if (event.type === 'tool.started') calls.push(event.properties.toolCallId);
  });
  try {
    const session = s.store.createSession();
    await expect(s.service.submit(session.id, 'request')).rejects.toThrow(
      'evidence could not be recorded',
    );
    expect(calls).toEqual(['one']);
    expect(s.store.latestRun(session.id)?.status).toBe('failed');
  } finally {
    record.mockRestore();
    await s.close();
  }
});

test('terminal persistence failure preserves the original failure and closes admission', async () => {
  const s = await setup({
    async generate() {
      throw new AppError('original', 'Original model failure');
    },
  });
  const fail = spyOn(s.store, 'failRun').mockImplementation(() => {
    throw new Error('disk');
  });
  try {
    const session = s.store.createSession();
    await expect(s.service.submit(session.id, 'request')).rejects.toThrow('Original model failure');
    expect(s.service.runtimeStatus().closing).toBe(true);
    expect(() => s.service.submit(session.id, 'next')).toThrow('shutting down');
    expect(s.store.latestRun(session.id)?.status).toBe('running');
  } finally {
    fail.mockRestore();
    await s.close();
  }
});
