import { expect, test } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';
import { handler } from '../../src/api';
import { AppError } from '../../src/shared/types';

test('the complete conversation process preserves intermediate replies, skill/read/script calls and results after restart', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  let step = 0;
  const marker = 'private-process-argument';
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate(_messages, _signal, text, reasoning) {
      step++;
      const content = [
        'Load the skill.',
        'Read its reference.',
        'Execute the example.',
        'Final answer.',
      ][step - 1]!;
      text(content);
      reasoning?.(`Reasoning ${step}.`);
      const call =
        step === 1
          ? { id: 'load', name: 'skill', input: { name: 'hello-world' } }
          : step === 2
            ? { id: 'read', name: 'read', input: { skill: 'hello-world', path: 'reference.txt' } }
            : {
                id: 'execute',
                name: 'execute_script',
                input: {
                  skill: 'hello-world',
                  path: 'scripts/main.js',
                  args: [marker, f.config.apiKey!],
                },
              };
      return {
        text: content,
        reasoning: `Reasoning ${step}.`,
        toolCalls: step < 4 ? [call] : [],
        usage: { totalTokens: 1 },
      };
    },
  });
  const events: unknown[] = [];
  service.events.subscribe((event) => events.push(event));
  try {
    const session = store.createSession();
    await service.submit(session.id, 'Run the example');
    const runId = store.latestRun(session.id)!.id;
    const process = store.transcripts.read(session.id, runId);
    expect(process.entries.map((entry) => [entry.entryId, entry.status])).toEqual([
      ['model:1', 'completed'],
      ['tool:load', 'completed'],
      ['model:2', 'completed'],
      ['tool:read', 'completed'],
      ['model:3', 'completed'],
      ['tool:execute', 'completed'],
      ['model:4', 'completed'],
    ]);
    expect(
      process.entries.filter((entry) => entry.kind === 'model').map((entry) => entry.text),
    ).toEqual(['Load the skill.', 'Read its reference.', 'Execute the example.', 'Final answer.']);
    expect(
      process.entries.filter((entry) => entry.kind === 'model').map((entry) => entry.reasoning),
    ).toEqual(['Reasoning 1.', 'Reasoning 2.', 'Reasoning 3.', 'Reasoning 4.']);
    const execution = store.transcripts.readDetail(session.id, runId, 'tool:execute');
    expect(execution.input).toMatchObject({ args: [marker, '[redacted]'] });
    expect(execution.result).toMatchObject({
      output: { stdout: expect.stringContaining('Hello ' + marker) },
    });
    expect(store.transcripts.readDetail(session.id, runId, 'tool:read').result?.output).toBe(
      'Use the supplied arguments.',
    );
    expect(
      store.transcripts.readDetail(session.id, runId, 'tool:load').result?.modelText,
    ).toContain('Read reference.txt');
    expect(JSON.stringify(events)).not.toContain(marker);
    expect(await Bun.file(service.diagnostics.paths().agent).text()).not.toContain(marker);
    const request = handler(service);
    const headers = { Authorization: `Bearer ${f.config.token}` };
    const history = await (
      await request(
        new Request(`http://local/session/${session.id}/message?process=true&reasoning=true`, {
          headers,
        }),
      )
    ).json();
    expect(history.at(-1).runId).toBe(runId);
    expect(store.messages(session.id).at(-1)).not.toHaveProperty('runId');
    const other = store.createSession();
    expect(
      (
        await request(
          new Request(`http://local/session/${other.id}/runs/${runId}/trace?entry=tool%3Aexecute`, {
            headers,
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          new Request(`http://local/session/${session.id}/runs/${runId}/trace?view=process`),
        )
      ).status,
    ).toBe(401);
    await service.shutdown();
    store.close();
    const reopened = new Store(f.config.dataDir);
    try {
      expect(reopened.transcripts.read(session.id, runId)).toEqual(process);
      expect(reopened.transcripts.readDetail(session.id, runId, 'tool:execute')).toEqual(execution);
    } finally {
      reopened.close();
    }
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('failed and dependency-blocked calls remain in order with partial model output', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  let step = 0;
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate(_messages, _signal, text) {
      if (++step === 1)
        return {
          text: 'Try loading.',
          toolCalls: [
            { id: 'missing', name: 'skill', input: { name: 'not-installed' } },
            {
              id: 'blocked',
              name: 'read',
              input: { skill: 'not-installed', path: 'reference.txt' },
            },
          ],
          usage: { totalTokens: 1 },
        };
      text('Partial response before failure.');
      throw new AppError('model_failure', 'Provider failed');
    },
  });
  try {
    const session = store.createSession();
    await expect(service.submit(session.id, 'request')).rejects.toThrow('Provider failed');
    const runId = store.latestRun(session.id)!.id;
    const process = store.transcripts.read(session.id, runId);
    expect(process.entries.map((entry) => entry.status)).toEqual([
      'completed',
      'failed',
      'dependency_blocked',
      'failed',
    ]);
    expect(process.entries.at(-1)?.text).toBe('Partial response before failure.');
    expect(store.transcripts.readDetail(session.id, runId, 'tool:blocked').result).toMatchObject({
      output: { error: 'dependency_blocked' },
    });
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('cancellation retains already completed skill calls and the in-flight text and reasoning', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  let step = 0,
    ready!: () => void;
  const entered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate(_messages, signal, text, reasoning) {
      if (++step === 1)
        return {
          text: 'Load first.',
          toolCalls: [{ id: 'load', name: 'skill', input: { name: 'hello-world' } }],
          usage: { totalTokens: 1 },
        };
      text('Partial text.');
      reasoning?.('Partial reasoning.');
      ready();
      return await new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  try {
    const session = store.createSession();
    const pending = service.submit(session.id, 'request');
    void pending.catch(() => {});
    await entered;
    await service.abort(session.id);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    const runId = store.latestRun(session.id)!.id;
    const process = store.transcripts.read(session.id, runId);
    expect(process.entries[1]).toMatchObject({ name: 'skill', status: 'completed' });
    expect(process.entries[2]).toMatchObject({
      status: 'cancelled',
      text: 'Partial text.',
      reasoning: 'Partial reasoning.',
    });
    expect(store.transcripts.readDetail(session.id, runId, 'tool:load').result?.status).toBe(
      'completed',
    );
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('unknown effects retain the returned process output without replaying or putting it in event metadata', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const executor = new ScriptExecutor(f.config, skills);
  executor.execute = async () => ({
    status: 'failed',
    started: true,
    exitCode: 1,
    stdout: JSON.stringify({
      error: {
        code: 'OUTCOME_UNKNOWN',
        message: 'Uncertain result',
        operationId: 'operation-reference',
      },
    }),
    stderr: 'private-captured-process-stderr',
  });
  let step = 0;
  const service = new AgentService(f.config, store, skills, executor, {
    async generate() {
      return {
        text: '',
        usage: { totalTokens: 1 },
        toolCalls: [
          ++step === 1
            ? { id: 'load', name: 'skill', input: { name: 'hello-world' } }
            : {
                id: 'unknown',
                name: 'execute_script',
                input: { skill: 'hello-world', path: 'scripts/main.js' },
              },
        ],
      };
    },
  });
  const events: unknown[] = [];
  service.events.subscribe((event) => events.push(event));
  try {
    const session = store.createSession();
    await expect(service.submit(session.id, 'request')).rejects.toMatchObject({
      code: 'waiting_for_operator',
    });
    const runId = store.latestRun(session.id)!.id;
    expect(store.transcripts.read(session.id, runId).entries.at(-1)?.status).toBe('unknown');
    const result = store.transcripts.readDetail(session.id, runId, 'tool:unknown').result;
    expect(result).toMatchObject({
      effect: 'unknown',
      output: {
        stdout: expect.stringContaining('operation-reference'),
        stderr: 'private-captured-process-stderr',
      },
    });
    expect(JSON.stringify(events)).not.toContain('private-captured-process-stderr');
    expect(step).toBe(2);
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
