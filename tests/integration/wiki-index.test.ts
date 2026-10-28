import { expect, test, spyOn } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from '../helpers';
import { samFixture } from '../case-helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';
import { SourceIndex } from '../../src/wiki/file-index';
import { handler } from '../../src/api';

test('Wiki source API and tool authenticate, explicitly index, search and read cited evidence', async () => {
  const f = await fixture();
  const root = join(f.dir, 'cases');
  await mkdir(join(root, '石墨'), { recursive: true });
  await writeFile(join(root, '石墨', 'case.SAM'), samFixture());
  const config = { ...f.config, wikiIndexRoots: [root], resourceLimitBytes: 65536 };
  const store = new Store(config.dataDir),
    skills = new Skills(config);
  await skills.discover();
  let step = 0;
  const service = new AgentService(config, store, skills, new ScriptExecutor(config, skills), {
    async generate(messages) {
      if (step++ === 0)
        return {
          text: '',
          usage: { totalTokens: 1 },
          toolCalls: [{ id: 'load', name: 'skill', input: { name: 'hello-world' } }],
        };
      if (step === 2)
        return {
          text: '',
          usage: { totalTokens: 1 },
          toolCalls: [
            {
              id: 'search',
              name: 'wiki',
              input: {
                skill: 'hello-world',
                action: 'search',
                query: '石墨',
                filters: { product: 'g5' },
              },
            },
          ],
        };
      const content = JSON.stringify(messages);
      expect(content).toContain('status-family');
      expect(content).toContain('Historical configuration evidence');
      if (step === 3) {
        const last = JSON.parse(JSON.stringify(messages.at(-1)));
        return {
          text: '',
          usage: { totalTokens: 1 },
          toolCalls: [
            {
              id: 'read',
              name: 'wiki',
              input: {
                skill: 'hello-world',
                action: 'read',
                id: last.content[0].output.value.results[0].id,
              },
            },
          ],
        };
      }
      expect(content).toContain('"sourceVerified":true');
      return {
        text: 'Found a historical case, not a runnable template.',
        usage: { totalTokens: 1 },
        toolCalls: [],
      };
    },
  });
  const request = handler(service);
  const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
  const call = (path: string, init: RequestInit = {}) =>
    request(new Request('http://local' + path, { ...init, headers }));
  try {
    expect((await request(new Request('http://local/wiki/index'))).status).toBe(401);
    expect((await (await call('/wiki/index')).json()).state).toBe('unbuilt');
    expect(
      (await call('/wiki/index/update', { method: 'POST', body: '{"root":"ignored"}' })).status,
    ).toBe(400);
    expect((await call('/wiki/index/update', { method: 'POST', body: '{}' })).status).toBe(200);
    const search = await (
      await call('/wiki/search?query=石墨&filters=' + encodeURIComponent('{"product":"g5"}'))
    ).json();
    expect(search.results).toHaveLength(1);
    const read = await (await call('/wiki/source/' + search.results[0].id)).json();
    expect(read.sourceVerified).toBe(true);
    expect(read.record.configuration.executionVerified).toBe(false);
    expect((await call('/wiki/search?limit=bad')).status).toBe(400);
    expect((await call('/wiki/search?filters=%5B%5D')).status).toBe(400);
    expect(
      (await service.submit(store.createSession('Cases').id, 'Find graphite cases')).content,
    ).toContain('historical case');
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('Wiki source update concurrency and shutdown cancel extraction without partial publication', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      throw new Error('No model call');
    },
  });
  const update = spyOn(SourceIndex.prototype, 'update').mockImplementation(async (signal) => {
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
    throw new Error('unreachable');
  });
  try {
    const pending = service.updateWikiIndex(new AbortController().signal);
    void pending.catch(() => {});
    expect(() => service.updateWikiIndex(new AbortController().signal)).toThrow('already running');
    await service.shutdown();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(store.db.query('SELECT count(*) AS count FROM wiki_index_meta').get()).toEqual({
      count: 0,
    });
  } finally {
    update.mockRestore();
    store.close();
    await f.cleanup();
  }
});

test('source and compiled Wiki indexing is local, explicit and usable outside repository cwd', async () => {
  const f = await fixture();
  const root = join(f.dir, 'library');
  await mkdir(root);
  await writeFile(join(root, 'template.SAM'), samFixture());
  const configPath = join(f.dir, 'cases.json');
  await writeFile(
    configPath,
    JSON.stringify({
      ...f.config,
      dataDir: './case-data',
      wikiIndexRoots: ['./library'],
      token: undefined,
    }),
  );
  const env = { ...process.env, AUTO_AGENT_API_KEY: '' };
  const entry = process.env.AUTO_AGENT_TEST_BINARY
    ? [
        resolve(
          process.env.AUTO_AGENT_TEST_BINARY_PATH ??
            join('dist', process.platform === 'win32' ? 'auto-agent.exe' : 'auto-agent'),
        ),
      ]
    : [process.execPath, resolve('src/index.ts')];
  try {
    for (let pass = 0; pass < 2; pass++) {
      const process = Bun.spawn([...entry, '--config', configPath, '--wiki-index'], {
        cwd: f.dir,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toContain('no model request');
      expect(stderr).not.toContain('API_KEY is not set');
      expect(JSON.parse(stdout)).toMatchObject({ records: 1, errors: 0, reused: pass });
    }
  } finally {
    await f.cleanup();
  }
});

test.skipIf(!process.env.AUTO_AGENT_TEST_BINARY)(
  'compiled program loads the embedded SQLite template snapshot outside the repository',
  async () => {
    const f = await fixture();
    try {
      const config = join(f.dir, 'snapshot.json');
      await writeFile(
        config,
        JSON.stringify({ ...f.config, builtinWiki: true, wikiIndexRoots: [], token: undefined }),
      );
      const binary = resolve(
        process.env.AUTO_AGENT_TEST_BINARY_PATH ??
          join('dist', process.platform === 'win32' ? 'auto-agent.exe' : 'auto-agent'),
      );
      const child = Bun.spawn([binary, '--config', config, '--wiki-index'], {
        cwd: f.dir,
        env: { ...process.env, AUTO_AGENT_API_KEY: '' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).not.toContain('API_KEY is not set');
      expect(JSON.parse(stdout)).toMatchObject({
        records: 178,
        reused: 178,
        rebuilt: 0,
        errors: 0,
      });
    } finally {
      await f.cleanup();
    }
  },
);
