import { test, expect } from 'bun:test';
import { PassThrough, Readable, Writable } from 'node:stream';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../helpers';
import { Skills } from '../../src/skill';
import { Store } from '../../src/storage';
import { AgentService } from '../../src/agent';
import { ScriptExecutor } from '../../src/execution';
import { cli, argumentsFor } from '../../src/cli';
import type { ModelAdapter } from '../../src/shared/types';
function capture(input: Readable) {
  let stdout = '',
    stderr = '';
  return {
    io: {
      input,
      terminal: false,
      output: new Writable({
        write(chunk, _enc, done) {
          stdout += chunk.toString();
          done();
        },
      }),
      error: new Writable({
        write(chunk, _enc, done) {
          stderr += chunk.toString();
          done();
        },
      }),
    },
    output: () => stdout,
    errors: () => stderr,
  };
}
test('REPL serializes multiple messages in one session, handles errors and resumes history', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  let calls = 0;
  const model: ModelAdapter = {
    async generate(messages, _signal, delta) {
      calls++;
      if (calls === 2) throw new Error('private error');
      const text = 'reply ' + messages.filter((m) => m.role === 'user').length;
      delta(text);
      return { text, toolCalls: [], usage: { totalTokens: 1 } };
    },
  };
  const service = new AgentService(
    f.config,
    store,
    skills,
    new ScriptExecutor(f.config, skills),
    model,
  );
  try {
    const c = capture(Readable.from(['first\nsecond\nthird\n/exit\nignored\n']));
    await cli(argumentsFor([]), f.config, service, c.io);
    expect(c.output()).toContain('reply 1');
    expect(c.output()).toContain('reply 3');
    expect(c.errors()).toContain('Internal operation failed');
    expect(calls).toBe(3);
    expect(store.listSessions().length).toBe(1);
    const session = store.listSessions()[0];
    expect(store.messages(session.id).length).toBe(6);
    const resumed = capture(Readable.from(['/exit\n']));
    await cli(argumentsFor(['--session', session.id]), f.config, service, resumed.io);
    expect(resumed.output()).toContain('user: first');
    expect(store.listSessions().length).toBe(1);
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
test('REPL JSON replies do not mix in process events or ANSI codes', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate(_messages, _signal, delta, reasoning) {
      reasoning?.('private reasoning display');
      delta('hello');
      return { text: 'hello', usage: { totalTokens: 1 }, toolCalls: [] };
    },
  });
  try {
    const c = capture(Readable.from(['hi\n/exit\n']));
    await cli(argumentsFor(['--json']), f.config, service, {
      ...c.io,
      terminal: true,
      color: true,
    });
    expect(c.output()).not.toContain('\x1b');
    expect(c.output()).not.toContain('[model]');
    expect(c.output()).not.toContain('[agent]');
    const replies = c
      .output()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toBe('hello');
    expect(c.errors()).toContain('Session:');
    expect(c.output()).not.toContain('private reasoning display');
    expect(c.errors()).not.toContain('private reasoning display');
    const resumed = capture(Readable.from(['/exit\n']));
    await cli(
      argumentsFor(['--json', '--session', store.listSessions()[0].id]),
      f.config,
      service,
      { ...resumed.io, terminal: true, color: true },
    );
    const history = resumed
      .output()
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(history[1].content).toBe('hello');
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
test('Ctrl+C during generation aborts it and keeps REPL available', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const model: ModelAdapter = {
    generate(_messages, signal) {
      started();
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new Error('abort'));
        else signal.addEventListener('abort', () => reject(new Error('abort')), { once: true });
      });
    },
  };
  const service = new AgentService(
    f.config,
    store,
    skills,
    new ScriptExecutor(f.config, skills),
    model,
  );
  const input = new PassThrough();
  const c = capture(input);
  try {
    const running = cli(argumentsFor([]), f.config, service, c.io);
    input.write('wait\n');
    await ready;
    process.emit('SIGINT');
    input.end('/exit\n');
    await running;
    expect(c.errors()).toContain('cancelled');
    expect(store.messages(store.listSessions()[0].id).at(-1)?.content).toContain(
      'does not confirm',
    );
  } finally {
    input.destroy();
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
test('no command starts REPL and old command words are chat text rather than dispatch', async () => {
  const f = await fixture();
  const file = join(f.dir, 'config.json');
  await writeFile(file, JSON.stringify({ ...f.config, token: undefined }));
  try {
    const env = { ...process.env };
    delete env.AUTO_AGENT_TOKEN;
    delete env.AUTO_AGENT_API_KEY;
    const child = Bun.spawn([Bun.argv[0], resolve('src', 'index.ts'), '--config', file], {
      env,
      stdin: new Blob(['/exit\n']),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('Session:');
    expect(stderr).toContain('/exit');
    const config = f.config;
    const store = new Store(config.dataDir);
    const skills = new Skills(config);
    await skills.discover();
    const service = new AgentService(config, store, skills, new ScriptExecutor(config, skills), {
      async generate(messages) {
        expect(messages.at(-1)?.content).toBe('session list');
        return { text: 'chat response', toolCalls: [], usage: { totalTokens: 1 } };
      },
    });
    try {
      const c = capture(Readable.from(['/exit\n']));
      await cli(argumentsFor(['session', 'list']), config, service, c.io);
      expect(c.output()).toContain('chat response');
    } finally {
      await service.shutdown();
      store.close();
    }
  } finally {
    await f.cleanup();
  }
});
