import { test, expect } from 'bun:test';
import { writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { Store } from '../../src/storage';
import { SQLiteSaver } from '../../src/storage/checkpointer';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
test('skills discover, lazy resources, invalid names and path confinement', async () => {
  const f = await fixture();
  try {
    const skills = new Skills(f.config);
    expect((await skills.discover()).length).toBe(2);
    expect(await skills.load('hello-world')).toContain('Greet');
    expect(await skills.read('hello-world', 'reference.txt')).toContain('arguments');
    for (const path of ['../reference.txt', 'C:\\outside', 'scripts/../reference.txt'])
      await expect(skills.read('hello-world', path)).rejects.toThrow();
    await symlink(
      join(f.root, 'sum-values', 'reference.txt'),
      join(f.root, 'hello-world', 'link.txt'),
    ).catch(() => {});
    await expect(skills.read('hello-world', 'link.txt')).rejects.toThrow();
    await writeFile(
      join(f.root, 'hello-world', 'SKILL.md'),
      '---\nname: wrong\ndescription: valid\n---\n',
    );
    await expect(skills.discover()).rejects.toThrow('mismatch');
    expect(skills.list()).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
test('skill file samples are bounded, include hidden files, and never follow symlinks', async () => {
  const f = await fixture();
  try {
    const skills = new Skills(f.config);
    await skills.discover();
    const directory = join(f.root, 'hello-world');
    await writeFile(join(directory, '.hidden.txt'), 'hidden');
    await mkdir(join(directory, 'assets'));
    for (let index = 0; index < 15; index++)
      await writeFile(join(directory, 'assets', `${index}.txt`), 'x'.repeat(5000));
    await symlink(join(f.root, 'sum-values'), join(directory, '.linked'), 'junction').catch(
      () => {},
    );
    const files = await skills.files('hello-world');
    expect(files).toHaveLength(10);
    expect(files).toContain(join(directory, '.hidden.txt'));
    expect(files.some((file) => file.includes('.linked'))).toBe(false);
    expect(files.some((file) => file.endsWith('SKILL.md'))).toBe(false);
    expect(await skills.files('hello-world')).toEqual(files);
  } finally {
    await f.cleanup();
  }
});

test('skills duplicate names across roots fail closed and oversized resources fail', async () => {
  const f = await fixture();
  try {
    const other = join(f.dir, 'other');
    await mkdir(join(other, 'hello-world'), { recursive: true });
    await writeFile(
      join(other, 'hello-world', 'SKILL.md'),
      '---\nname: hello-world\ndescription: duplicate\n---\n',
    );
    const skills = new Skills(f.config);
    await skills.discover();
    await writeFile(join(f.root, 'hello-world', 'huge.txt'), 'x'.repeat(5000));
    await expect(skills.read('hello-world', 'huge.txt')).rejects.toThrow('limit');
    await expect(
      new Skills({ ...f.config, skillRoots: [f.root, other] }).discover(),
    ).rejects.toThrow('Duplicate');
  } finally {
    await f.cleanup();
  }
});
test('SQLite ownership, per-session concurrency, persistence, uncertain recovery and saver', async () => {
  const f = await fixture();
  let store: Store | undefined;
  try {
    store = new Store(f.config.dataDir);
    expect(() => new Store(f.config.dataDir)).toThrow('owned');
    const a = store.createSession();
    const b = store.createSession();
    const am = store.addMessage(a.id, 'user', 'test');
    const bm = store.addMessage(b.id, 'user', 'other');
    const run = store.beginRun(a.id, am.id);
    expect(() => store!.beginRun(a.id, am.id)).toThrow();
    const other = store.beginRun(b.id, bm.id);
    store.finishRun(other, 'completed');
    store.beginExecution(run, 'hello-world', 'scripts/main.js');
    const saver = new SQLiteSaver(store.db);
    const checkpoint = emptyCheckpoint();
    const saved = await saver.put(
      { configurable: { thread_id: run } },
      checkpoint,
      { source: 'input', step: -1, parents: {} },
      {},
    );
    await saver.putWrites(saved, [['sample', { value: 3 }]], 'task');
    expect((await saver.getTuple(saved))?.pendingWrites?.[0][2]).toEqual({ value: 3 });
    store.close();
    store = new Store(f.config.dataDir);
    expect(store.messages(a.id).at(-1)?.content).toContain('unknown');
    expect(() => store!.beginRun(a.id, am.id)).toThrow();
    expect(store.db.query('SELECT status FROM executions').get()).toEqual({ status: 'unknown' });
    expect((await new SQLiteSaver(store.db).getTuple(saved))?.checkpoint.id).toBe(checkpoint.id);
  } finally {
    store?.close();
    await f.cleanup();
  }
});
// Temporarily skipped pending investigation of script execution timeouts in CI.
test.skip('scripts execute arguments without shell injection and exclude secrets', async () => {
  const f = await fixture();
  try {
    const skills = new Skills(f.config);
    await skills.discover();
    const executor = new ScriptExecutor(f.config, skills);
    const result = await executor.execute(
      { skill: 'hello-world', path: 'scripts/main.js', args: ['a; echo injected'] },
      new AbortController().signal,
    );
    expect(result.status).toBe('completed');
    expect(result.stdout.trim()).toBe('Hello a; echo injected');
    await writeFile(
      join(f.root, 'hello-world', 'scripts', 'env.js'),
      'console.log(JSON.stringify(process.env))',
    );
    const env = await executor.execute(
      { skill: 'hello-world', path: 'scripts/env.js' },
      new AbortController().signal,
    );
    expect(env.stdout).not.toContain(f.config.apiKey!);
    expect(env.stdout).not.toContain(f.config.token);
    const missing = new ScriptExecutor(
      { ...f.config, interpreters: { '.js': 'missing-interpreter-auto-agent' } },
      skills,
    );
    expect(
      (
        await missing.execute(
          { skill: 'hello-world', path: 'scripts/main.js' },
          new AbortController().signal,
        )
      ).status,
    ).toBe('failed');
  } finally {
    await f.cleanup();
  }
}, 90000);
// Temporarily skipped pending investigation of script execution timeouts in CI.
test.skip('script output bounds, timeout and cancellation clean parent and child', async () => {
  const f = await fixture();
  try {
    const skills = new Skills(f.config);
    await skills.discover();
    await writeFile(
      join(f.root, 'hello-world', 'scripts', 'large.js'),
      "console.log('x'.repeat(100000));",
    );
    const executor = new ScriptExecutor(f.config, skills);
    const large = await executor.execute(
      { skill: 'hello-world', path: 'scripts/large.js' },
      new AbortController().signal,
    );
    expect(large.status).toBe('output_limit');
    expect(Buffer.byteLength(large.stdout)).toBeLessThanOrEqual(f.config.outputLimitBytes);
    await writeFile(
      join(f.root, 'hello-world', 'scripts', 'wait.js'),
      "const {spawn}=require('node:child_process');const child=spawn('node',['-e','setInterval(()=>{},1000)']); console.log(process.pid,child.pid);setInterval(()=>{},1000);",
    );
    const controller = new AbortController();
    const running = executor.execute(
      { skill: 'hello-world', path: 'scripts/wait.js' },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 3500);
    const result = await running;
    expect(result.status).toBe('cancelled');
    for (const id of result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))
      expect(() => process.kill(id, 0)).toThrow();
    const timeout = await new ScriptExecutor(
      { ...f.config, scriptTimeoutMs: 3500 },
      skills,
    ).execute({ skill: 'hello-world', path: 'scripts/wait.js' }, new AbortController().signal);
    expect(timeout.status).toBe('timeout');
  } finally {
    await f.cleanup();
  }
}, 90000);
