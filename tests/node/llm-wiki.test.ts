import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmWiki, discoverText, type IngestModel } from '@auto-agent/llm-wiki';
import { configSchema, DATA_LAYOUT, ensureConfig, loadConfig } from 'auto-agent/config';
import { ingestLlmWiki } from 'auto-agent/wiki/ingest';
import { listenFetch } from './http-fixture';

test('configuration exposes only text LLM Wiki sources and rejects SQLite bundle configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent-llm-config-'));
  const path = join(root, 'config.json');
  try {
    ensureConfig(path);
    assert.equal(await readFile(join(root, '.data-layout'), 'utf8'), DATA_LAYOUT);
    assert.deepEqual(loadConfig(path).llmWiki, { sources: [] });
    assert.deepEqual(loadConfig(path).climber, {
      enabled: true,
      serviceURL: 'http://127.0.0.1:18080/api/v1',
      timeoutMs: 5000,
    });
    await writeFile(
      path,
      JSON.stringify({
        climber: { enabled: false, serviceURL: 'http://manufacturer.example:18080/api/v1' },
      }),
    );
    ensureConfig(path);
    assert.deepEqual(loadConfig(path).climber, {
      enabled: false,
      serviceURL: 'http://manufacturer.example:18080/api/v1',
      timeoutMs: 5000,
    });
    for (const raw of [
      { wiki: {} },
      { llmWiki: { bundles: [] } },
      { llmWiki: { builtin: true } },
      { llmWiki: { sources: [{ id: 'db', type: 'file', path: 'library.sqlite' }] } },
    ])
      assert.equal(configSchema.safeParse(raw).success, false);
    await writeFile(path, 'invalid json');
    ensureConfig(path);
    assert.throws(() => loadConfig(path));
    assert.equal(await readFile(path, 'utf8'), 'invalid json');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('LLM ingest persists knowledge pages, reuses complete results and preserves the last publication on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent-llm-content-'));
  const path = join(root, 'source.md');
  const signal = new AbortController().signal;
  try {
    await writeFile(path, '# 石墨原文\n预处理条件：200 ℃，2 h');
    const { documents } = await discoverText([{ id: 'material', type: 'file', path }], signal);
    const wiki = new LlmWiki(join(root, 'knowledge'));
    let calls = 0;
    const model: IngestModel = {
      identity: 'local-fake',
      maxPromptBytes: 100000,
      async complete(request) {
        calls++;
        if (request.stage === 'analysis') return '原文说明石墨的预处理条件，保留单位和来源。';
        const input = JSON.parse(request.prompt.split('\n\n')[0]);
        return JSON.stringify({
          pages: [
            {
              path: input.source.summaryPath,
              title: '石墨原文',
              type: 'source',
              summary: '来源摘要',
              body: '# 石墨原文\n200 ℃，2 h',
              sources: [input.source.reference],
              related: ['concepts/石墨.md'],
            },
            {
              path: 'concepts/石墨.md',
              title: '石墨',
              type: 'concept',
              summary: '有来源的预处理条件',
              body: '# 石墨\n原文明确为 200 ℃、2 h。',
              sources: [input.source.reference],
              related: [input.source.summaryPath],
            },
          ],
          issues: [],
        });
      },
    };
    await wiki.ingest(documents[0], model, signal);
    assert.equal(calls, 2);
    const hit = (await wiki.search('石墨')).results.find(
      (row) => row.reference.path === 'concepts/石墨.md',
    )!;
    assert.match((await wiki.read(hit.reference)).text, /200 ℃/);
    assert.equal((await wiki.ingest(documents[0], model, signal)).reused, true);
    assert.equal(calls, 2);
    const published = (await wiki.catalog()).generation;
    await writeFile(path, '# 更新原文\n300 ℃');
    const updated = (await discoverText([{ id: 'material', type: 'file', path }], signal))
      .documents[0];
    await assert.rejects(
      wiki.ingest(
        updated,
        {
          ...model,
          async complete() {
            throw new Error('local failure');
          },
        },
        signal,
      ),
    );
    assert.equal((await wiki.catalog()).generation, published);
    assert.match((await wiki.read(hit.reference)).text, /200 ℃/);
    await writeFile(join(root, 'disguised.md'), Buffer.from('SQLite format 3\0binary'));
    await assert.rejects(
      discoverText([{ id: 'bad', type: 'file', path: join(root, 'disguised.md') }], signal),
      /纯文本/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Wiki ingestion can compile knowledge through an anonymous private model service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent-anonymous-wiki-'));
  const previousKey = process.env.AUTO_AGENT_API_KEY;
  delete process.env.AUTO_AGENT_API_KEY;
  let calls = 0;
  const server = await listenFetch(async (request) => {
    assert.equal(request.headers.get('authorization'), null);
    const body = (await request.json()) as { messages: { role: string; content: string }[] };
    calls++;
    let answer = '原文提供私有资料的概念和来源。';
    if (calls > 1) {
      const prompt = body.messages.find((message) => message.role === 'user')!.content;
      const input = JSON.parse(prompt.split('\n\n')[0]);
      answer = JSON.stringify({
        pages: [
          {
            path: input.source.summaryPath,
            title: '私有资料',
            type: 'source',
            summary: '来源摘要',
            body: '# 私有资料\n保留原始说明。',
            sources: [input.source.reference],
            related: [],
          },
        ],
        issues: [],
      });
    }
    return Response.json({
      id: 'anonymous-local',
      object: 'chat.completion',
      created: 1,
      model: 'private-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    });
  });
  try {
    const path = join(root, 'source.md');
    await writeFile(path, '# 私有资料\n保留原始说明。');
    const result = await ingestLlmWiki(
      configSchema.parse({
        dataDir: root,
        model: 'arbitrary-private-model',
        baseURL: `${server.origin}/v1`,
        llmWiki: { sources: [{ id: 'private', type: 'file', path }] },
      }),
      undefined,
      new AbortController().signal,
    );
    assert.equal(result.status, 'completed');
    assert.equal(result.completed.length, 1);
    assert.equal(calls, 2);
  } finally {
    if (previousKey === undefined) delete process.env.AUTO_AGENT_API_KEY;
    else process.env.AUTO_AGENT_API_KEY = previousKey;
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
