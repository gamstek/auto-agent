import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile, readdir, unlink, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from '../helpers';
import { Wiki, parseKnowledge } from '../../src/wiki';
import { Skills } from '../../src/skill';
import { Store } from '../../src/storage';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';
import { AppError, type ModelAdapter } from '../../src/shared/types';
import { CloudModel } from '../../src/llm';

const document = '石墨\t仅需测比表面积\t氮气77K\t200-300℃，2h\tBET（0.05-0.3）';
const builtinTemplate = '比表面积及孔径分析仪自动化模板.md';
function preprocessingLine(source: string): number {
  const match = source.match(/^(\d+): .*石墨.*200-300℃，2h/m);
  if (!match) throw new Error('Expected numbered graphite preprocessing source');
  return Number(match[1]);
}
const knowledge = () => ({
  summary: '材料测试建议',
  records: [
    {
      title: '石墨比表面积',
      terms: ['石墨', '比表面积'],
      facts: {
        preprocessing: { value: '200-300℃，2h', citations: [{ line: 1, quote: '200-300℃，2h' }] },
      },
      issues: ['温度范围尚未选择；BET字段语义未明确'],
    },
  ],
  issues: ['此表只包含推荐条件，并非完整软件配置'],
});
test.skipIf(!process.env.AUTO_AGENT_TEST_BINARY)(
  'compiled binary embeds wiki outside the repository without external roots',
  async () => {
    const f = await fixture();
    f.config.resourceLimitBytes = 65536;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        const body = await request.json();
        const source = body.messages
          .map((message: { content: string }) => message.content)
          .join('\n');
        const k = knowledge();
        k.records[0].facts.preprocessing.citations[0].line = preprocessingLine(source);
        return Response.json({
          id: 'wiki',
          object: 'chat.completion',
          created: 1,
          model: 'test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: JSON.stringify(k) },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const configPath = join(f.dir, 'config.json');
      await writeFile(
        configPath,
        JSON.stringify({
          ...f.config,
          builtinWiki: true,
          baseURL: `http://127.0.0.1:${server.port}/v1`,
        }),
      );
      const child = Bun.spawn(
        [
          resolve(process.env.AUTO_AGENT_TEST_BINARY_PATH ?? join('dist', 'auto-agent.exe')),
          '--config',
          configPath,
          '--wiki-update',
        ],
        {
          cwd: f.dir,
          env: { ...process.env, AUTO_AGENT_API_KEY: f.config.apiKey! },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).not.toContain('[error]');
      expect(code).toBe(0);
      expect(JSON.parse(stdout).sources).toBe(1);
      const snapshot = JSON.parse(
        await readFile(join(f.config.dataDir, 'wiki', 'snapshot.json'), 'utf8'),
      );
      expect(snapshot.sources[0].path).toBe(`builtin/${builtinTemplate}`);
    } finally {
      server.stop(true);
      await f.cleanup();
    }
  },
);

test('built-in wiki and external roots coexist, disable cleanly and detect modified extracted sources', async () => {
  const f = await fixture();
  f.config.resourceLimitBytes = 65536;
  f.config.builtinWiki = true;
  const external = join(f.dir, 'external');
  await mkdir(external);
  await writeFile(join(external, '模板.md'), document);
  f.config.wikiRoots = [external];
  let calls = 0;
  const model: ModelAdapter = {
    async generate() {
      throw new Error('unused');
    },
    async generateKnowledge(source) {
      calls++;
      const k = knowledge();
      k.records[0].facts.preprocessing.citations[0].line = preprocessingLine(source);
      return JSON.stringify(k);
    },
  };
  try {
    const wiki = new Wiki(f.config);
    expect((await wiki.update(model, new AbortController().signal)).sources).toBe(2);
    const results = ((await wiki.query('石墨')) as any).results;
    expect(
      results.map((r: any) => r.source).some((p: string) => p === `builtin/${builtinTemplate}`),
    ).toBe(true);
    expect(results.map((r: any) => r.source).some((p: string) => p.startsWith('external-'))).toBe(
      true,
    );
    expect(calls).toBe(2);
    f.config.builtinWiki = false;
    await expect(wiki.query('石墨')).rejects.toThrow('Run --wiki-update');
    expect((await wiki.update(model, new AbortController().signal)).sources).toBe(1);
    f.config.builtinWiki = true;
    const versions = await readdir(join(f.config.dataDir, 'builtin-wiki'));
    await writeFile(
      join(f.config.dataDir, 'builtin-wiki', versions[0]!, builtinTemplate),
      'modified',
    );
    await expect(wiki.query('石墨')).rejects.toThrow('modified');
    expect((await wiki.status()).state).toBe('invalid');
    f.config.builtinWiki = false;
    f.config.wikiRoots = [];
    expect((await wiki.status()).state).toBe('empty');
    await expect(wiki.update(model, new AbortController().signal)).rejects.toThrow('No Markdown');
  } finally {
    await f.cleanup();
  }
});

test('knowledge parser accepts whole JSON fences and whitespace-only quote differences, with precise failures', () => {
  const value = knowledge();
  value.records[0].facts.preprocessing.citations[0].quote = '200-300℃，2h BET（0.05-0.3）';
  const parsed = parseKnowledge('```json\n' + JSON.stringify(value) + '\n```', [document]);
  expect(parsed.records[0].facts.preprocessing.citations[0].quote).toBe(
    '200-300℃，2h\tBET（0.05-0.3）',
  );
  expect(() => parseKnowledge('{', [document])).toThrow('not a complete JSON');
  expect(() => parseKnowledge('{}', [document])).toThrow('schema validation failed');
  value.records[0].facts.preprocessing.citations[0].line = 99;
  expect(() => parseKnowledge(JSON.stringify(value), [document])).toThrow(
    'source line 99 is out of range',
  );
  value.records[0].facts.preprocessing.citations[0].line = 1;
  value.records[0].facts.preprocessing.citations[0].quote = '200℃，2h';
  expect(() => parseKnowledge(JSON.stringify(value), [document])).toThrow(
    'quotation does not match source line 1',
  );
  expect(() => parseKnowledge('Explanation\n' + JSON.stringify(knowledge()), [document])).toThrow(
    'not a complete JSON',
  );
});

async function setup() {
  const f = await fixture();
  f.config.wikiRoots = [join(f.dir, 'wiki')];
  f.config.resourceLimitBytes = 65536;
  await mkdir(f.config.wikiRoots[0]!);
  await writeFile(join(f.config.wikiRoots[0]!, 'template.txt'), document);
  return f;
}

test('explicit wiki builds validate citations, cache changes, preserve ranges and reject stale knowledge', async () => {
  const f = await setup();
  let calls = 0;
  const model: ModelAdapter = {
    async generate() {
      throw new Error('not used');
    },
    async generateKnowledge(source) {
      calls++;
      expect(source).toContain('1: 石墨');
      return JSON.stringify(knowledge());
    },
  };
  const wiki = new Wiki(f.config);
  try {
    await expect(wiki.query('石墨')).rejects.toThrow('Run --wiki-update');
    expect((await wiki.status()).state).toBe('unbuilt');
    expect(calls).toBe(0);
    expect((await wiki.update(model, new AbortController().signal)).rebuilt).toBe(1);
    expect(await wiki.status()).toMatchObject({ state: 'ready', records: 1 });
    expect((await wiki.update(model, new AbortController().signal)).rebuilt).toBe(0);
    expect(calls).toBe(1);
    const result = (await wiki.query('石墨 比表面积')) as any;
    expect(result.results[0].facts.preprocessing.value).toBe('200-300℃，2h');
    expect(result.results[0].source).toEndWith('/template.txt');
    expect(result.results[0].facts.preprocessing.citations[0].line).toBe(1);
    expect(result.status).toBe('recommendations_only');
    expect(((await wiki.query('未知材料')) as any).status).toBe('no_match');
    await writeFile(join(f.config.wikiRoots[0]!, 'template.txt'), document + '\n补充说明');
    await expect(wiki.query('石墨')).rejects.toThrow('Sources changed');
    expect((await wiki.status()).state).toBe('stale');
    expect((await wiki.update(model, new AbortController().signal)).rebuilt).toBe(1);
    expect(calls).toBe(2);
    expect(await readFile(join(f.config.wikiRoots[0]!, 'template.txt'), 'utf8')).toBe(
      document + '\n补充说明',
    );
    await expect(wiki.query('石墨', 11)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test('explicit updates recover malformed and incompatible snapshots while queries fail closed', async () => {
  const f = await setup();
  const wiki = new Wiki(f.config);
  const path = join(f.config.dataDir, 'wiki', 'snapshot.json');
  let calls = 0;
  const model: ModelAdapter = {
    async generate() {
      throw new Error('unused');
    },
    async generateKnowledge() {
      calls++;
      return JSON.stringify(knowledge());
    },
  };
  try {
    await mkdir(join(f.config.dataDir, 'wiki'), { recursive: true });
    for (const invalid of ['{broken', JSON.stringify({ revision: 'obsolete', sources: [] })]) {
      await writeFile(path, invalid);
      await expect(wiki.query('石墨')).rejects.toThrow('Wiki snapshot is invalid');
      expect((await wiki.status()).state).toBe('invalid');
      const before = calls;
      expect((await wiki.update(model, new AbortController().signal)).rebuilt).toBe(1);
      expect(calls).toBe(before + 1);
      expect((await wiki.status()).state).toBe('ready');
      expect((await wiki.query('石墨')) as any).toHaveProperty('status', 'recommendations_only');
    }
    await writeFile(path, '{broken');
    const bad = knowledge();
    bad.records[0].facts.preprocessing.citations[0].quote = 'not in source';
    await expect(
      wiki.update(
        {
          ...model,
          async generateKnowledge() {
            return JSON.stringify(bad);
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid knowledge');
    expect(await readFile(path, 'utf8')).toBe('{broken');
    const controller = new AbortController();
    controller.abort();
    await expect(wiki.update(model, controller.signal)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{broken');
    expect((await readdir(join(f.config.dataDir, 'wiki'))).sort()).toEqual([
      'revisions',
      'snapshot.json',
    ]);
  } finally {
    await f.cleanup();
  }
});

test('bad generated citations and cancellation retain the last snapshot without temporary files', async () => {
  const f = await setup();
  const wiki = new Wiki(f.config);
  const model: ModelAdapter = {
    async generate() {
      throw new Error('not used');
    },
    async generateKnowledge() {
      return JSON.stringify(knowledge());
    },
  };
  try {
    await wiki.update(model, new AbortController().signal);
    const path = join(f.config.dataDir, 'wiki', 'snapshot.json');
    const previous = await readFile(path, 'utf8');
    await writeFile(join(f.config.wikiRoots[0]!, 'template.txt'), document + '\n新版');
    const bad = knowledge();
    bad.records[0].facts.preprocessing.citations[0].quote = '不在原文';
    await expect(
      wiki.update(
        {
          ...model,
          async generateKnowledge() {
            return JSON.stringify(bad);
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Invalid knowledge');
    expect(await readFile(path, 'utf8')).toBe(previous);
    const controller = new AbortController();
    controller.abort();
    await expect(wiki.update(model, controller.signal)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe(previous);
    expect((await readdir(join(f.config.dataDir, 'wiki'))).sort()).toEqual([
      'revisions',
      'snapshot.json',
    ]);
  } finally {
    await f.cleanup();
  }
});

test('wiki knowledge tool is gated by current generation skill loading and returns source data', async () => {
  const f = await setup();
  const wiki = new Wiki(f.config);
  await wiki.update(
    {
      async generate() {
        throw new Error('not used');
      },
      async generateKnowledge() {
        return JSON.stringify(knowledge());
      },
    },
    new AbortController().signal,
  );
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  let step = 0;
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate(messages) {
      step++;
      if (step === 2) expect(JSON.stringify(messages)).toContain('skill_not_loaded');
      if (step === 4) expect(JSON.stringify(messages)).toContain('200-300℃');
      const call =
        step === 1 || step === 3
          ? {
              id: String(step),
              name: 'query_knowledge',
              input: { skill: 'hello-world', query: '石墨 比表面积' },
            }
          : { id: String(step), name: 'skill', input: { name: 'hello-world' } };
      return {
        text: step === 4 ? '有来源的推荐草稿，尚未配置仪器' : '',
        toolCalls: step === 4 ? [] : [call],
        totalTokens: 1,
      };
    },
  });
  try {
    const reply = await service.submit(store.createSession().id, '石墨比表面积');
    expect(reply.content).toContain('尚未配置仪器');
    expect(step).toBe(4);
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('source removal updates the snapshot, source limits and symlinks fail closed', async () => {
  const f = await setup();
  const wiki = new Wiki(f.config);
  const model: ModelAdapter = {
    async generate() {
      throw new Error('not used');
    },
    async generateKnowledge() {
      return JSON.stringify(knowledge());
    },
  };
  try {
    await writeFile(join(f.config.wikiRoots[0]!, 'other.txt'), document);
    expect((await wiki.update(model, new AbortController().signal)).sources).toBe(2);
    await unlink(join(f.config.wikiRoots[0]!, 'other.txt'));
    await expect(wiki.query('石墨')).rejects.toThrow('Sources changed');
    expect(await wiki.update(model, new AbortController().signal)).toMatchObject({
      sources: 1,
      rebuilt: 0,
    });
    f.config.resourceLimitBytes = 1;
    await expect(wiki.query('石墨')).rejects.toThrow('exceed');
    f.config.resourceLimitBytes = 65536;
    await symlink(f.config.wikiRoots[0]!, join(f.config.wikiRoots[0]!, 'linked'), 'junction');
    await expect(wiki.query('石墨')).rejects.toThrow('symbolic links');
  } finally {
    await f.cleanup();
  }
});

test('real template source is numbered without hardcoded interpretation; model output retains source issues', async () => {
  const f = await setup();
  const text = await readFile(join(import.meta.dir, '..', '..', 'wiki', builtinTemplate), 'utf8');
  await writeFile(join(f.config.wikiRoots[0]!, 'template.txt'), text);
  const k = knowledge();
  const quote = '200-300℃，2h';
  const line =
    text.split(/\r?\n/).findIndex((value) => value.includes('石墨') && value.includes(quote)) + 1;
  expect(line).toBeGreaterThan(0);
  k.records[0].facts.preprocessing.citations = [{ line, quote }];
  k.issues = ['温度范围尚未选择；原文建议不自动纠正'];
  try {
    await new Wiki(f.config).update(
      {
        async generate() {
          throw new Error('not used');
        },
        async generateKnowledge(source) {
          expect(preprocessingLine(source)).toBe(line);
          expect(source).toContain('二氧化碳273K');
          return JSON.stringify(k);
        },
      },
      new AbortController().signal,
    );
    const result = (await new Wiki(f.config).query('石墨 比表面积')) as any;
    expect(result.results[0].facts.preprocessing.citations[0]).toEqual({ line, quote });
    expect(result.results[0].sourceIssues[0]).toContain('温度范围');
  } finally {
    await f.cleanup();
  }
});

test('explicit CLI update persists knowledge, exits, and skips unchanged sources without a model request', async () => {
  const f = await setup();
  let requests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async () => {
      requests++;
      return Response.json({
        id: 'knowledge',
        object: 'chat.completion',
        created: 1,
        model: 'test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(knowledge()) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  try {
    const configPath = join(f.dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({ ...f.config, baseURL: `http://127.0.0.1:${server.port}/v1` }),
    );
    for (const rebuilt of [1, 0]) {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, '..', '..', 'src', 'index.ts'),
          '--config',
          configPath,
          '--wiki-update',
        ],
        {
          env: { ...process.env, AUTO_AGENT_API_KEY: f.config.apiKey! },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(JSON.parse(stdout).rebuilt).toBe(rebuilt);
      expect(stderr).toContain('Explicit wiki update');
    }
    expect(requests).toBe(1);
    expect(((await new Wiki(f.config).query('石墨')) as any).results).toHaveLength(1);
  } finally {
    server.stop(true);
    await f.cleanup();
  }
});

test('output truncation splits extraction scope while preserving full context and original citations', async () => {
  const f = await setup();
  await writeFile(join(f.config.wikiRoots[0]!, 'template.txt'), document + '\n硬碳\t300℃，6h');
  let calls = 0;
  try {
    const model: ModelAdapter = {
      async generate() {
        throw new Error('not used');
      },
      async generateKnowledge(source) {
        calls++;
        if (calls === 1) throw new AppError('wiki_output_limit', 'truncated');
        expect(source).toContain('1: 石墨');
        expect(source).toContain('2: 硬碳');
        if (source.includes('lines 1–1 ONLY')) return JSON.stringify(knowledge());
        expect(source).toContain('lines 2–2 ONLY');
        return JSON.stringify({
          summary: '硬碳',
          records: [
            {
              title: '硬碳',
              terms: ['硬碳'],
              facts: {
                preprocessing: { value: '300℃，6h', citations: [{ line: 2, quote: '300℃，6h' }] },
              },
              issues: [],
            },
          ],
          issues: [],
        });
      },
    };
    await new Wiki(f.config).update(model, new AbortController().signal);
    expect(calls).toBe(3);
    const result = (await new Wiki(f.config).query('硬碳')) as any;
    expect(result.results[0].facts.preprocessing.citations[0].line).toBe(2);
    expect((await new Wiki(f.config).update(model, new AbortController().signal)).rebuilt).toBe(0);
    expect(calls).toBe(3);
  } finally {
    await f.cleanup();
  }
});

test('single-line output truncation terminates without publishing partial knowledge', async () => {
  const f = await setup();
  let calls = 0;
  try {
    await expect(
      new Wiki(f.config).update(
        {
          async generate() {
            throw new Error('not used');
          },
          async generateKnowledge() {
            calls++;
            throw new AppError('wiki_output_limit', 'truncated');
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow('line 1');
    expect(calls).toBe(1);
    await expect(new Wiki(f.config).query('石墨')).rejects.toThrow('Run --wiki-update');
  } finally {
    await f.cleanup();
  }
});

test('knowledge generation uses a tool-free model request with numbered source data', async () => {
  const f = await setup();
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as any;
      expect(body.tools).toBeUndefined();
      expect(body.messages[0].content).toContain('exact source-line citations');
      expect(body.messages[1].content).toBe('1: ' + document);
      return Response.json({
        id: 'knowledge',
        object: 'chat.completion',
        created: 1,
        model: 'test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(knowledge()) },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  try {
    f.config.baseURL = `http://127.0.0.1:${server.port}/v1`;
    expect(
      JSON.parse(
        await new CloudModel(f.config).generateKnowledge(
          '1: ' + document,
          new AbortController().signal,
        ),
      ),
    ).toEqual(knowledge());
  } finally {
    server.stop(true);
    await f.cleanup();
  }
});
