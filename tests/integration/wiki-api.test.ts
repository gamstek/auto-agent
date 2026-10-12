import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';
import { handler } from '../../src/api';
import type { ModelAdapter } from '../../src/shared/types';

const content = '石墨 200-300℃，2h';
const generated = JSON.stringify({
  summary: '模板建议',
  records: [
    {
      title: '石墨',
      terms: ['石墨'],
      facts: {
        preprocessing: { value: '200-300℃，2h', citations: [{ line: 1, quote: '200-300℃，2h' }] },
      },
      issues: [],
    },
  ],
  issues: [],
});
async function setup(model: ModelAdapter) {
  const f = await fixture();
  const root = join(f.dir, 'wiki');
  await mkdir(root);
  await writeFile(join(root, 'template.txt'), content);
  f.config.wikiRoots = [root];
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
  const fetch = handler(service);
  const request = (path: string, method = 'GET', body?: string, signal?: AbortSignal) =>
    fetch(
      new Request(`http://localhost${path}`, {
        method,
        body,
        signal,
        headers: { Authorization: 'Bearer ' + f.config.token },
      }),
    );
  return {
    f,
    service,
    fetch,
    request,
    cleanup: async () => {
      await service.shutdown();
      store.close();
      await f.cleanup();
    },
  };
}

test('wiki API authenticates, reports status, updates incrementally and bounds queries', async () => {
  let calls = 0;
  const s = await setup({
    async generate() {
      throw new Error('not used');
    },
    async generateKnowledge() {
      calls++;
      return generated;
    },
  });
  try {
    for (const [path, method] of [
      ['/wiki', 'GET'],
      ['/wiki/query?query=x', 'GET'],
      ['/wiki/update', 'POST'],
    ])
      expect((await s.fetch(new Request('http://localhost' + path, { method }))).status).toBe(401);
    expect((await (await s.request('/wiki')).json()).state).toBe('unbuilt');
    expect(calls).toBe(0);
    expect((await s.request('/wiki/query?query=石墨')).status).toBe(400);
    expect((await s.request('/wiki/update', 'POST', '{')).status).toBe(400);
    expect((await s.request('/wiki/update', 'POST', '{"wikiRoots":["arbitrary"]}')).status).toBe(
      400,
    );
    expect((await (await s.request('/wiki/update', 'POST', '{}')).json()).rebuilt).toBe(1);
    expect((await (await s.request('/wiki/update', 'POST')).json()).rebuilt).toBe(0);
    expect(calls).toBe(1);
    const status = await s.request('/wiki');
    expect(status.headers.get('Cache-Control')).toBe('no-store');
    expect((await status.json()).state).toBe('ready');
    expect(
      (await (await s.request('/wiki/query?query=石墨&limit=1')).json()).results[0].facts
        .preprocessing.value,
    ).toBe('200-300℃，2h');
    for (const query of [
      '',
      'query=',
      'query=x&limit=0',
      'query=x&limit=11',
      'query=x&limit=1.5',
      'query=x&limit=',
    ])
      expect((await s.request('/wiki/query?' + query)).status).toBe(400);
    expect((await s.request('/wiki/update', 'GET')).status).toBe(404);
    await writeFile(join(s.f.config.wikiRoots[0], 'template.txt'), content + '\nchanged');
    expect((await (await s.request('/wiki')).json()).state).toBe('stale');
  } finally {
    await s.cleanup();
  }
});

test('wiki API bounds complete successful responses and rejects an impossible metadata budget', async () => {
  const s = await setup({
    async generate() {
      throw new Error('unused');
    },
    async generateKnowledge() {
      return generated;
    },
  });
  try {
    expect((await s.request('/wiki/update', 'POST')).status).toBe(200);
    const complete = await (await s.request('/wiki/query?query=石墨')).text();
    const bytes = Buffer.byteLength(complete);
    s.f.config.resourceLimitBytes = bytes;
    expect(await (await s.request('/wiki/query?query=石墨')).text()).toBe(complete);
    s.f.config.resourceLimitBytes = bytes - 1;
    const limited = await s.request('/wiki/query?query=石墨');
    const text = await limited.text();
    expect(limited.status).toBe(200);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(bytes - 1);
    expect(JSON.parse(text)).toMatchObject({
      status: 'output_limit',
      results: [],
      truncated: true,
    });
    s.f.config.resourceLimitBytes = 512;
    const missing = await s.request('/wiki/query?query=unknown-material');
    expect(missing.status).toBe(200);
    const missingText = await missing.text();
    expect(Buffer.byteLength(missingText)).toBeLessThanOrEqual(512);
    expect(JSON.parse(missingText)).toMatchObject({
      status: 'no_match',
      results: [],
      truncated: true,
    });
    s.f.config.resourceLimitBytes = Buffer.byteLength(content) + 1;
    for (const query of ['石墨', 'unknown-material']) {
      const failed = await s.request('/wiki/query?query=' + encodeURIComponent(query));
      expect(failed.status).toBe(400);
      expect(await failed.json()).toHaveProperty('error', 'wiki_output_limit');
    }
  } finally {
    await s.cleanup();
  }
});

test('wiki updates are mutually exclusive and shutdown cancels without publishing', async () => {
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const s = await setup({
    async generate() {
      throw new Error('not used');
    },
    async generateKnowledge(_source, signal) {
      started();
      return new Promise<string>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  try {
    const running = s.request('/wiki/update', 'POST');
    await ready;
    expect((await s.request('/wiki/update', 'POST')).status).toBe(409);
    await s.service.shutdown();
    expect((await running).status).toBe(409);
    expect((await (await s.request('/wiki')).json()).state).toBe('unbuilt');
    expect((await s.request('/wiki/update', 'POST')).status).toBe(503);
  } finally {
    await s.cleanup();
  }
});

test('wiki request cancellation releases the update slot', async () => {
  let calls = 0;
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const s = await setup({
    async generate() {
      throw new Error('not used');
    },
    async generateKnowledge(_source, signal) {
      if (++calls > 1) return generated;
      started();
      return new Promise<string>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  });
  try {
    const controller = new AbortController();
    const running = s.request('/wiki/update', 'POST', '{}', controller.signal);
    await ready;
    controller.abort();
    expect((await running).status).toBe(409);
    expect((await s.request('/wiki/update', 'POST')).status).toBe(200);
  } finally {
    await s.cleanup();
  }
});
