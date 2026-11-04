import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from '../helpers';
import { samFixture } from '../case-helpers';
import { createWikiLibrary } from '../../src/integrations/wiki-library';
import { AgentService } from '../../src/agent';
import { Skills } from '../../src/skill';
import { Store } from '../../src/storage';
import { ScriptExecutor } from '../../src/execution';
import { handler } from '../../src/api';
import { loadConfig } from '../../src/config';
import type { ModelAdapter } from '../../src/shared/types';

async function setup(model: ModelAdapter) {
  const f = await fixture();
  const root = join(f.dir, 'sources');
  await mkdir(root);
  await writeFile(join(root, '石墨说明.md'), '# 石墨\n比表面积操作说明');
  await writeFile(join(root, '石墨.SAM'), samFixture());
  f.config.wiki = {
    sources: [
      {
        id: 'mixed',
        type: 'directory',
        path: root,
        collection: 'lab',
        include: ['**/*'],
        exclude: [],
      },
    ],
  };
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const library = createWikiLibrary(f.config)!;
  const service = new AgentService(
    f.config,
    store,
    skills,
    new ScriptExecutor(f.config, skills),
    model,
    undefined,
    library,
  );
  return {
    f,
    root,
    store,
    library,
    service,
    async close() {
      await service.shutdown();
      store.close();
      await f.cleanup();
    },
  };
}

test('configured Wiki uses a unified tool schema and reads mixed formats without skill loading', async () => {
  let step = 0;
  let readResult = '';
  const s = await setup({
    async generate(messages, _signal, _text, _reasoning, tools) {
      step++;
      if (step === 1) {
        expect(tools!.wiki!.description).toContain('configured local reference');
        expect(JSON.stringify(messages)).not.toContain('query returns compiled recommendations');
        return {
          text: '',
          toolCalls: [
            { id: 'search', name: 'wiki', input: { action: 'search', search: { query: '石墨' } } },
          ],
          usage: { totalTokens: 1 },
        };
      }
      if (step === 2) {
        const last = messages.at(-1) as any;
        const results = last.content[0].output.value.results;
        expect(results).toHaveLength(2);
        expect(new Set(results.map((entry: any) => entry.mediaType))).toEqual(
          new Set(['text/markdown', 'application/x-sam']),
        );
        return {
          text: '',
          toolCalls: [
            {
              id: 'read',
              name: 'wiki',
              input: {
                action: 'read',
                read: {
                  reference: results.find((entry: any) => entry.mediaType === 'text/markdown')
                    .reference,
                },
              },
            },
          ],
          usage: { totalTokens: 1 },
        };
      }
      readResult = JSON.stringify(messages.at(-1));
      return { text: 'Found cited source evidence.', toolCalls: [], usage: { totalTokens: 1 } };
    },
  });
  try {
    expect(s.library.catalog().generation).toBeUndefined();
    await s.service.refreshLibrary(new AbortController().signal);
    await s.service.submit(s.store.createSession().id, '读取石墨资料');
    expect(step).toBe(3);
    expect(readResult).toContain('比表面积操作说明');
    expect(readResult).not.toContain('skill_not_loaded');
  } finally {
    await s.close();
  }
});

test('HTTP and tools share versioned search; reading does not scan or rebuild originals', async () => {
  const s = await setup({
    async generate() {
      throw new Error('No model needed');
    },
  });
  const route = handler(s.service);
  const request = (path: string, body?: unknown) =>
    route(
      new Request('http://local' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${s.f.config.token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  try {
    expect((await route(new Request('http://local/wiki/catalog'))).status).toBe(401);
    expect((await request('/wiki/builds', { root: 'arbitrary' })).status).toBe(400);
    expect((await request('/wiki/builds', {})).status).toBe(200);
    const response = await request('/wiki/search', { query: '操作说明' });
    const result = await response.json();
    expect(result.results).toHaveLength(1);
    await writeFile(join(s.root, '石墨说明.md'), '# 石墨\n修改后的内容');
    const read = await (
      await request('/wiki/read', { reference: result.results[0].reference })
    ).json();
    expect(read.units[0].text).toContain('操作说明');
    expect(read.sourceVerified).toBe(false);
    expect((await request('/wiki/query?query=石墨')).status).toBe(404);
    expect(
      (
        await request('/wiki/search', {
          filters: [{ field: 'sam.product', op: 'eq', value: 'g5' }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await request('/wiki/search', { filters: [{ field: 'made.up', op: 'eq', value: 'g5' }] }))
        .status,
    ).toBe(400);
  } finally {
    await s.close();
  }
});

test('unified source paths resolve from configuration and CLI indexing/search need no model key', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.dir, 'docs'));
    await writeFile(join(f.dir, 'docs', 'manual.md'), '# 独立资料\n离线检索');
    const configFile = join(f.dir, 'wiki.json');
    await writeFile(
      configFile,
      JSON.stringify({
        ...f.config,
        dataDir: './state',
        wiki: { sources: [{ id: 'docs', type: 'directory', path: './docs' }] },
      }),
    );
    expect((await loadConfig(configFile, false, true)).wiki!.sources[0]!.path).toBe(
      join(f.dir, 'docs'),
    );
    for (const args of [
      ['wiki', 'refresh'],
      ['wiki', 'search', '离线检索'],
    ]) {
      const child = Bun.spawn(
        [process.execPath, resolve('src/index.ts'), '--config', configFile, ...args],
        {
          cwd: f.dir,
          env: { ...process.env, AUTO_AGENT_API_KEY: '' },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, err }).toMatchObject({ code: 0 });
      const result = JSON.parse(out);
      if (args[1] === 'refresh') expect(result.parsed).toBe(1);
      else expect(result.results[0].title).toBe('manual.md');
      expect(err).not.toContain('API_KEY is not set');
    }
    await writeFile(
      configFile,
      JSON.stringify({ ...f.config, wiki: { sources: [{ id: 'docs', type: 'directory' }] } }),
    );
    await expect(loadConfig(configFile, false, true)).rejects.toThrow('wiki.sources.0.path');
  } finally {
    await f.cleanup();
  }
});
