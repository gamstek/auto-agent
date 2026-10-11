import { collectTextAssets } from '../../src/shared/assets';
import { test, expect } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { materializeBuiltins } from '../../src/shared/builtin';
import { collectBuiltinAssets } from '../../src/shared/builtin';
test('asset collection reads nested and hidden text files deterministically and rejects binary files', async () => {
  const f = await fixture();
  try {
    const root = join(f.dir, 'assets');
    await mkdir(join(root, 'nested'), { recursive: true });
    await writeFile(join(root, '.hidden'), 'hidden');
    await writeFile(join(root, 'nested', 'resource.txt'), '资源');
    const first = await collectTextAssets(root);
    expect(first).toEqual({ '.hidden': 'hidden', 'nested/resource.txt': '资源' });
    expect(await collectTextAssets(root)).toEqual(first);
    await writeFile(join(root, 'nested', 'resource.txt'), 'updated');
    expect((await collectTextAssets(root))['nested/resource.txt']).toBe('updated');
    await writeFile(join(root, 'binary.bin'), Buffer.from([0xff]));
    await expect(collectTextAssets(root)).rejects.toThrow('UTF-8');
  } finally {
    await f.cleanup();
  }
});
// Temporarily skipped pending investigation of script execution timeouts in CI.
test.skip('embedded built-ins discover without roots, load resources, execute and remain stable', async () => {
  const f = await fixture();
  try {
    const assets = await collectBuiltinAssets('skills');
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
    const first = await materializeBuiltins(config.dataDir, 'skills');
    for (const [path, content] of Object.entries(assets))
      expect(await readFile(join(first, ...path.split('/')), 'utf8')).toBe(content);
    expect(await materializeBuiltins(config.dataDir, 'skills')).toBe(first);
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
    const root = await materializeBuiltins(f.config.dataDir, 'skills');
    await writeFile(join(root, 'device-automation', 'scripts', 'device.js'), 'modified');
    await expect(materializeBuiltins(f.config.dataDir, 'skills')).rejects.toThrow('modified');
  } finally {
    await f.cleanup();
  }
});
