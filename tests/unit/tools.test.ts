import { expect, spyOn, test } from 'bun:test';
import { BuiltinToolRegistry, toolSchemas } from '../../src/tool';
import * as web from '../../src/tool/tools/web-fetch';
import * as search from '../../src/tool/tools/web-search';
import { toolFixture } from '../tool-helpers';
import { z } from 'zod';

const registry = new BuiltinToolRegistry();

test('registry co-locates schemas and execution but gives the model declarations only', () => {
  const specs = registry.specs();
  const modelTools = registry.modelTools();
  expect(Object.keys(modelTools)).toEqual(specs.map((spec) => spec.name));
  expect(modelTools).toHaveProperty('execute_script');
  expect(modelTools).not.toHaveProperty('execute_skill_script');
  for (const spec of specs) {
    const schema = z.toJSONSchema(spec.inputSchema, { io: 'input' });
    expect(schema.type).toBe('object');
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(spec.inputSchema).toBe(toolSchemas[spec.name as keyof typeof toolSchemas]);
    expect(typeof spec.execute).toBe('function');
    expect(spec.outputSchema).toBeDefined();
    expect(spec.effects.length).toBeGreaterThan(0);
    expect(modelTools[spec.name]).not.toHaveProperty('execute');
  }
});

test('Wiki publishes an object schema while retaining per-action requirements and defaults', () => {
  expect(toolSchemas.wiki.parse({ action: 'catalog' })).toEqual({ action: 'catalog' });
  expect(toolSchemas.wiki.parse({ action: 'search', search: {} })).toEqual({ action: 'search', search: { query: '', filters: [], limit: 10 } });
  const id = 'a'.repeat(64);
  const reference = { documentId: id, versionId: id, representationId: id };
  expect(toolSchemas.wiki.parse({ action: 'read', read: { reference } })).toEqual({ action: 'read', read: { reference, offset: 0, limit: 20, maxBytes: 32768 } });
  for (const invalid of [
    {}, { action: 'search' }, { action: 'read' }, { action: 'catalog', search: {} },
    { action: 'read', read: { reference: { documentId: id } } },
    { action: 'search', search: { limit: 0 } },
  ])
    expect(() => toolSchemas.wiki.parse(invalid)).toThrow();
});

test('registry rejects unknown and inherited tool names before execution', async () => {
  const f = toolFixture();
  for (const name of ['missing', 'constructor', 'toString', '__proto__']) {
    await expect(registry.execute(name, {}, f.context)).rejects.toThrow('Tool is not available');
  }
  expect(f.calls).toEqual([]);
});

test('registry validates inputs, skill gates and defaults before invoking capabilities', async () => {
  const f = toolFixture();
  await expect(registry.execute('skill', { name: '' }, f.context)).rejects.toThrow();
  for (const [name, input] of [
    ['read', { skill: 'example', path: 'reference.txt' }],
    ['execute_script', { skill: 'example', path: 'scripts/main.js' }],
  ] as const) {
    await expect(registry.execute(name, input, f.context)).rejects.toThrow(
      'Load skill instructions',
    );
  }
  expect(f.calls).toEqual([]);
  const loaded = await registry.execute('skill', { name: 'example' }, f.context);
  expect(loaded.status).toBe('completed');
  expect(loaded.modelText).toContain('Follow example guidance.');
  expect(loaded.modelText).not.toContain('---');
  expect(f.context.run.loadedSkills.has('example')).toBe(true);
  expect(
    await registry.execute('wiki', { action: 'catalog' }, f.context),
  ).toMatchObject({ output: { sources: [] }, status: 'completed' });
  expect(
    await registry.execute('read', { skill: 'example', path: 'reference.txt' }, f.context),
  ).toEqual({ output: 'Resource text', status: 'completed', effect: 'none' });
  await registry.execute(
    'wiki',
    { action: 'search', search: { query: 'sample' } },
    f.context,
  );
  expect(f.calls.find((call) => call.name === 'wiki-search')?.input).toEqual({
    query: 'sample',
    filters: [],
    limit: 10,
  });
  await registry.execute(
    'execute_script',
    { skill: 'example', path: 'scripts/main.js' },
    f.context,
  );
  expect(f.calls.find((call) => call.name === 'execute')?.input).toEqual({
    skill: 'example',
    path: 'scripts/main.js',
    args: [],
  });
});

test('web fetch dispatch uses context without requiring skill loading', async () => {
  const f = toolFixture();
  const page = {
    url: 'https://example.com/page',
    status: 200,
    contentType: 'text/plain',
    text: 'Fixture',
    truncated: false,
  };
  const fetch = spyOn(web, 'fetchWeb').mockResolvedValue(page);
  try {
    expect(await registry.execute('web_fetch', { url: page.url }, f.context)).toEqual({
      output: page,
      status: 'completed',
      effect: 'none',
    });
    expect(fetch.mock.calls[0]).toEqual([page.url, f.context.run.signal, f.context.network]);
    await expect(registry.execute('web_fetch', { url: 'not a URL' }, f.context)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});

test('web search validates bounded queries and dispatches without a loaded skill', async () => {
  const f = toolFixture();
  const results = {
    query: 'public information',
    provider: 'exa' as const,
    results: [],
    status: 'no_results' as const,
    truncated: false,
  };
  const lookup = spyOn(search, 'searchWeb').mockResolvedValue(results);
  try {
    expect(
      await registry.execute('web_search', { query: '  public information  ' }, f.context),
    ).toEqual({ output: results, status: 'completed', effect: 'none' });
    expect(lookup.mock.calls[0]).toEqual([
      'public information',
      5,
      f.context.run.signal,
      f.context.network,
    ]);
    expect(registry.specs().find((spec) => spec.name === 'web_search')?.effects).toEqual([
      'network',
    ]);
    for (const input of [
      { query: '   ' },
      { query: 'x'.repeat(1001) },
      { query: 'public', limit: 0 },
      { query: 'public', limit: 11 },
      { query: 'public', limit: 1.5 },
    ]) {
      await expect(registry.execute('web_search', input, f.context)).rejects.toThrow();
    }
    expect(lookup).toHaveBeenCalledTimes(1);
  } finally {
    lookup.mockRestore();
  }
});

test('registry rejects malformed outputs without leaking their contents', async () => {
  const f = toolFixture();
  const fetch = spyOn(web, 'fetchWeb').mockResolvedValue({
    url: 'https://example.com/',
    status: 700,
    contentType: 'text/plain',
    text: 'SECRET',
    truncated: false,
  });
  try {
    await expect(
      registry.execute('web_fetch', { url: 'https://example.com/' }, f.context),
    ).rejects.toMatchObject({ code: 'tool_output', message: 'Tool returned an invalid result' });
  } finally {
    fetch.mockRestore();
  }
});

test('invalid process outputs stop dependent work for operator review', async () => {
  const f = toolFixture();
  await registry.execute('skill', { name: 'example' }, f.context);
  f.context.executor.execute = async () => ({
    status: 'completed',
    stdout: 'SECRET',
    stderr: '',
    exitCode: NaN,
  });
  await expect(
    registry.execute('execute_script', { skill: 'example', path: 'scripts/main.js' }, f.context),
  ).rejects.toMatchObject({ code: 'uncertain_execution' });
});

test('failed skill activation does not grant access or leak into another generation', async () => {
  const f = toolFixture();
  f.context.skills.files = async () => {
    throw new Error('Unreadable catalog');
  };
  await expect(registry.execute('skill', { name: 'example' }, f.context)).rejects.toThrow();
  expect(f.context.run.loadedSkills.size).toBe(0);
  const fresh = toolFixture();
  await registry.execute('skill', { name: 'example' }, fresh.context);
  expect(f.context.run.loadedSkills.size).toBe(0);
});
