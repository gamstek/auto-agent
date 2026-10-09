import { test, expect } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers';
import { Skills } from '../../src/skills';
import { ScriptExecutor } from '../../src/execution';
import { materializeBuiltins } from '../../src/skills/builtin';
import { builtinAssets } from '../../src/skills/builtin-assets.generated';
import { collectBuiltinAssets } from '../../scripts/generate-builtin-assets';
test('embedded built-ins discover without roots, load resources, execute and remain stable', async () => {
  const f = await fixture();
  try {
    expect(builtinAssets).toEqual(await collectBuiltinAssets());
    const config = { ...f.config, skillRoots: [], builtinSkills: true };
    const skills = new Skills(config);
    expect((await skills.discover()).map((s) => s.name)).toEqual(['device-automation']);
    expect(skills.source('device-automation')).toBe('built-in');
    expect(await skills.load('device-automation')).toContain('virtual device simulator');
    const result = await new ScriptExecutor(config, skills).execute(
      { skill: 'device-automation', path: 'scripts/device.js', args: ['turn-on', 'desk-lamp'] },
      new AbortController().signal,
    );
    expect(result.status).toBe('completed');
    expect(JSON.parse(result.stdout)).toMatchObject({
      simulated: true,
      device: { id: 'desk-lamp', powered: true, brightness: 50 },
    });
    const first = await materializeBuiltins(config.dataDir);
    expect(await materializeBuiltins(config.dataDir)).toBe(first);
  } finally {
    await f.cleanup();
  }
}, 30000);
test('built-ins disable cleanly, duplicate names fail, modified resources are not silently trusted', async () => {
  const f = await fixture();
  try {
    const disabled = new Skills({ ...f.config, skillRoots: [], builtinSkills: false });
    expect(await disabled.discover()).toEqual([]);
    const configured = new Skills(f.config);
    await configured.discover();
    expect(configured.source('hello-world')).toBe('configured');
    const duplicateRoot = join(f.root, 'device-automation');
    await mkdir(duplicateRoot);
    await writeFile(
      join(duplicateRoot, 'SKILL.md'),
      '---\nname: device-automation\ndescription: Duplicate built-in skill.\n---\n',
    );
    await expect(new Skills({ ...f.config, builtinSkills: true }).discover()).rejects.toThrow(
      'Duplicate',
    );
    const root = await materializeBuiltins(f.config.dataDir);
    await writeFile(join(root, 'device-automation', 'scripts', 'device.js'), 'modified');
    await expect(materializeBuiltins(f.config.dataDir)).rejects.toThrow('modified');
  } finally {
    await f.cleanup();
  }
});
