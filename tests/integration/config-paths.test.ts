import { test, expect } from 'bun:test';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../helpers';
import { loadConfig, ensureDefaultConfig } from '../../src/config';
import { Skills } from '../../src/skill';
import { DEFAULT_SYSTEM_PROMPT, systemInstructions } from '../../src/agent/prompt';
import { skillGuidance } from '../../src/skill/prompt';
test('repository config discovers example skills and the formal built-in analyzer workflow', async () => {
  const config = await loadConfig(resolve('examples', 'config.json'), false, true);
  expect(config.skillRoots).toEqual([resolve('examples', 'skills')]);
  expect(config.dataDir).toBe(resolve('.auto-agent'));
  expect(config.wikiRoots).toEqual([resolve('examples', 'wiki')]);
  expect(config.builtinWiki).toBe(true);
  const skills = new Skills(config);
  const catalog = await skills.discover();
  expect(catalog.map((skill) => skill.name).sort()).toEqual([
    'device-automation',
    'hello-world',
    'sum-values',
  ]);
  expect(skills.source('device-automation')).toBe('built-in');
  expect(skills.source('hello-world')).toBe('configured');
  const prompt = systemInstructions(config.systemPrompt);
  expect(prompt).toContain('You are Auto-Agent');
  expect(prompt).toContain('specific surface area and pore size analyzers');
  expect(prompt).toContain('not a completed experiment');
  expect(prompt).toContain('simulator result is only a simulation');
  expect(prompt).toContain('Software cancellation does not prove');
  expect(prompt).toContain('BET, BJH, and DFT');
  expect(prompt).toContain('Preserve raw data');
  expect(prompt).not.toContain('hello-world');
  expect(prompt).not.toContain('<available_skills>');
  expect(prompt).not.toContain('only skill,');
  expect(prompt).not.toContain('skill tool description');
  expect(prompt).not.toContain('Read a UTF-8 resource from a loaded skill');
  expect(prompt).not.toContain('execute_skill_script');
  expect(prompt).toContain('trusted local SKILL.md instructions');
  expect(prompt).toContain('Load a skill in the current generation');
  expect(prompt).toContain('conversation history is not currently loaded');
  expect(prompt).toContain('Read the returned guidance before issuing dependent');
  expect(prompt).toContain('Use relevant data as evidence');
  expect(prompt).toContain('Process exit success alone does not establish');
  expect(prompt).toContain('Do not work around a runtime denial');
  expect(systemInstructions('Custom role')).toContain('Runtime contract:');
  expect(systemInstructions('   ')).toBe(systemInstructions());
  const description = skillGuidance(catalog);
  expect(description).toContain('<name>hello-world</name>');
  expect(description).toContain('<name>sum-values</name>');
});
test('installed default config uses user data and no implicit repository skill trust', async () => {
  const f = await fixture();
  try {
    const created = await ensureDefaultConfig(f.dir);
    const config = await loadConfig(created.path, false, true);
    expect(config.dataDir).toBe(join(f.dir, '.auto-agent'));
    expect(config.skillRoots).toEqual([]);
    expect(config.builtinSkills).toBe(true);
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
