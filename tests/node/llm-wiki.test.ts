import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmWiki, discoverText, type IngestModel } from '@auto-agent/llm-wiki';
import { configSchema, DATA_LAYOUT, ensureConfig, loadConfig } from '../../lib/config';

test('configuration exposes only text LLM Wiki sources and rejects SQLite bundle configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent-llm-config-'));
  const path = join(root, 'config.json');
  try {
    ensureConfig(path);
    assert.equal(await readFile(join(root, '.data-layout'), 'utf8'), DATA_LAYOUT);
    assert.deepEqual(loadConfig(path).llmWiki, { sources: [] });
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
