import { test, expect } from 'bun:test';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../helpers';
import { loadConfig, ensureDefaultConfig } from '../../src/config';
import { Skills } from '../../src/skill';
import { toolGuidance } from '../../src/tool/prompt';
import { skillGuidance } from '../../src/skill/prompt';
test('repository config discovers example skills and the formal built-in analyzer workflow', async () => {
  const config = await loadConfig(resolve('examples', 'config.json'), false, true);
  expect(config.skillRoots).toEqual([resolve('examples', 'skills')]);
  expect(config.dataDir).toBe(resolve('.auto-agent'));
  expect(config.wikiRoots).toEqual([]);
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
  const description = skillGuidance(catalog);
  expect(description).toContain('trusted local SKILL.md');
  expect(description).toContain('current generation');
  expect(description).toContain('<name>hello-world</name>');
  expect(description).toContain('<name>sum-values</name>');
});
test('tool guidance reflects the configured network policy independently of the role and skill guidance', () => {
  for (const allowPrivate of [false, true]) {
    const prompt = toolGuidance(allowPrivate);
    expect(prompt.match(/<address_policy>/g)).toHaveLength(1);
    expect(prompt).toContain(`webAllowPrivateAddresses=${allowPrivate}`);
    expect(prompt).not.toContain(`webAllowPrivateAddresses=${!allowPrivate}`);
    expect(prompt).not.toContain('<skill_prerequisites>');
    expect(prompt).toContain('sourceVerified=false');
    expect(prompt).not.toContain('<available_skills>');
  }
  expect(skillGuidance([])).toContain('<skill_prerequisites>');
  expect(skillGuidance([])).not.toContain('webAllowPrivateAddresses');
});
test('installed default config uses user data and no implicit repository skill trust', async () => {
  const f = await fixture();
  try {
    const created = await ensureDefaultConfig(f.dir);
    const config = await loadConfig(created.path, false, true);
    expect(config.dataDir).toBe(join(f.dir, '.auto-agent'));
    expect(config.skillRoots).toEqual([]);
    expect(config.builtinSkills).toBe(true);
    expect(config.systemPrompt).toBe('');
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
