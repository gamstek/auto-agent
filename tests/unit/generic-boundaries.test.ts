import { expect, test } from 'bun:test';

test('Agent, tool, MCP, config and audit core do not branch on domain names', async () => {
  const violations: string[] = [];
  for (const directory of ['src/agent', 'src/tool', 'src/mcp', 'src/config', 'src/storage']) {
    for await (const path of new Bun.Glob('**/*.ts').scan({ cwd: directory, absolute: true })) {
      const source = await Bun.file(path).text();
      if (
        /device-automation|climber|\bregister_batch\b|\bstart_batch\b|\bdevice_claims\b|input\.skill\s*===/i.test(
          source,
        )
      )
        violations.push(path);
    }
  }
  expect(violations).toEqual([]);
});

test('generation and context engines consume ports rather than application implementations', async () => {
  const runner = await Bun.file('src/agent/runner.ts').text();
  expect(runner).not.toMatch(/from ['"]\.\.\/(wiki|storage|skill|config|mcp|execution)(?:\/|['"])/);
  const context = await Bun.file('src/agent/context.ts').text();
  expect(context).not.toContain('toolSpecs');
  expect(context).not.toContain("'results' in");
  const model = await Bun.file('src/llm/index.ts').text();
  expect(model).not.toMatch(/BuiltinToolRegistry|KNOWLEDGE_PROMPT|SESSION_TITLE_PROMPT/);
  const script = await Bun.file('src/tool/tools/script.ts').text();
  expect(script).not.toMatch(/batchId|pendingInputs|sampleInputsComplete/);
});
