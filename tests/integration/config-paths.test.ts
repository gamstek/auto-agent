import { test, expect } from 'bun:test';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../helpers';
import { loadConfig, ensureDefaultConfig } from '../../src/config';
import { Skills } from '../../src/skills';
import { DEFAULT_SYSTEM_PROMPT, systemInstructions } from '../../src/agent/prompt';
test('repository config discovers both example skills independent of launch directory', async () => {
  const config = await loadConfig(resolve('examples', 'config.json'), false, true);
  expect(config.skillRoots).toEqual([resolve('examples', 'skills')]);
  expect(config.dataDir).toBe(resolve('.auto-agent'));
  const catalog = await new Skills(config).discover();
  expect(catalog.map((skill) => skill.name).sort()).toEqual(['hello-world', 'sum-values']);
  const prompt = systemInstructions(config.systemPrompt, catalog);
  expect(prompt).toContain('You are Auto-Agent');
  expect(prompt).toContain('hello-world');
  expect(prompt).toContain('sum-values');
});
test('installed default config uses user data and no implicit repository skill trust', async () => {
  const f = await fixture();
  try {
    const created = await ensureDefaultConfig(f.dir);
    const config = await loadConfig(created.path, false, true);
    expect(config.dataDir).toBe(join(f.dir, '.auto-agent'));
    expect(config.skillRoots).toEqual([]);
    expect(config.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    await writeFile(
      created.path,
      JSON.stringify({
        dataDir: '../custom-data',
        skillRoots: ['../skills'],
        systemPrompt: 'Custom role',
      }),
    );
    const custom = await loadConfig(created.path, false, true);
    expect(custom.dataDir).toBe(join(f.dir, 'custom-data'));
    expect(custom.skillRoots).toEqual([f.root]);
    expect(custom.systemPrompt).toBe('Custom role');
  } finally {
    await f.cleanup();
  }
});
