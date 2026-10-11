import { expect, test } from 'bun:test';
import { BuiltinToolRegistry, toolSchemas, type ToolHandlers } from '../../src/llm/tools';

const registry = new BuiltinToolRegistry();
function handlers(calls: unknown[]): ToolHandlers {
  const record = async (input: unknown) => {
    calls.push(input);
    return input;
  };
  return {
    skill: record,
    read_skill_resource: record,
    query_knowledge: record,
    execute_skill_script: record,
    web_fetch: record,
  };
}

test('registry provides one source of schemas and model tool definitions', () => {
  const specs = registry.specs();
  expect(Object.keys(registry.modelTools())).toEqual(specs.map((spec) => spec.name));
  for (const spec of specs) {
    expect(spec.inputSchema).toBe(toolSchemas[spec.name as keyof typeof toolSchemas]);
    expect(spec.effects.length).toBeGreaterThan(0);
  }
  expect(specs.find((spec) => spec.name === 'web_fetch')?.effects).toEqual(['network']);
});

test('registry rejects unknown and inherited tool names before execution', async () => {
  const calls: unknown[] = [];
  for (const name of ['missing', 'constructor', 'toString', '__proto__']) {
    await expect(registry.execute(name, {}, new Set(), handlers(calls))).rejects.toThrow(
      'Tool is not available',
    );
  }
  expect(calls).toEqual([]);
});

test('registry validates inputs and preserves loaded-skill gates and defaults', async () => {
  const calls: unknown[] = [];
  const dispatch = handlers(calls);
  await expect(registry.execute('skill', { name: '' }, new Set(), dispatch)).rejects.toThrow();
  for (const [name, input] of [
    ['read_skill_resource', { skill: 'example', path: 'reference.txt' }],
    ['query_knowledge', { skill: 'example', query: 'sample' }],
    ['execute_skill_script', { skill: 'example', path: 'scripts/main.js' }],
  ] as const) {
    await expect(registry.execute(name, input, new Set(), dispatch)).rejects.toThrow(
      'Load skill instructions',
    );
  }
  expect(calls).toEqual([]);
  expect(
    await registry.execute(
      'query_knowledge',
      { skill: 'example', query: 'sample' },
      new Set(['example']),
      dispatch,
    ),
  ).toEqual({ skill: 'example', query: 'sample', limit: 5 });
  expect(
    await registry.execute(
      'execute_skill_script',
      { skill: 'example', path: 'scripts/main.js' },
      new Set(['example']),
      dispatch,
    ),
  ).toEqual({ skill: 'example', path: 'scripts/main.js', args: [] });
});

test('web fetch dispatch does not depend on skill loading', async () => {
  const calls: unknown[] = [];
  expect(
    await registry.execute(
      'web_fetch',
      { url: 'https://example.com/page' },
      new Set(),
      handlers(calls),
    ),
  ).toEqual({ url: 'https://example.com/page' });
  await expect(
    registry.execute('web_fetch', { url: 'not a URL' }, new Set(), handlers(calls)),
  ).rejects.toThrow();
  expect(calls).toHaveLength(1);
});
