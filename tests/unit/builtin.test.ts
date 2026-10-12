import { collectTextAssets } from '../../src/shared/assets';
import { test, expect } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers';
import { Skills } from '../../src/skill';
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
test('formal built-in skill loads persistent simulation interfaces and preserves asset integrity', async () => {
  const f = await fixture();
  try {
    const assets = await collectBuiltinAssets('skills');
    const config = { ...f.config, skillRoots: [], builtinSkills: true, resourceLimitBytes: 16384 };
    const skills = new Skills(config);
    const catalog = await skills.discover();
    expect(catalog.map((s) => s.name)).toEqual(['device-automation']);
    expect(catalog[0]!.description).toContain('persistent instrument-interface simulation');
    expect(catalog[0]!.metadata.compatibility).toContain('Requires Auto-Agent and Node.js');
    expect(catalog[0]!.metadata.compatibility).not.toContain('builtin');
    expect(skills.source('device-automation')).toBe('built-in');
    const content = await skills.load('device-automation');
    expect(content).toContain('Surface area and pore size analyzer workflows');
    expect(content).toContain('wiki');
    expect(content).toContain('references/interfaces.md');
    expect(content).toContain('not an executable or validated instrument configuration');
    expect(content).not.toContain('scripts/device.js');
    const interfaces = await skills.read('device-automation', 'references/interfaces.md');
    expect(interfaces).toContain('local simulation only');
    expect(interfaces).toContain('AUTO_AGENT_SIMULATION_DIR');
    expect(interfaces).toContain('Measurement submission');
    expect(interfaces).toContain('Template saving');
    expect(Object.hasOwn(assets, 'device-automation/scripts/instrument.js')).toBe(true);
    expect(Object.hasOwn(assets, 'device-automation/scripts/device.js')).toBe(false);
    expect(
      (await skills.resolveScript('device-automation', 'scripts/instrument.js')).path,
    ).toEndWith('instrument.js');
    expect(
      (await skills.files('device-automation')).map((path) => path.replaceAll('\\', '/')),
    ).toContain(`${catalog[0]!.directory.replaceAll('\\', '/')}/references/interfaces.md`);
    await expect(skills.resolveScript('device-automation', 'scripts/device.js')).rejects.toThrow();
    const first = await materializeBuiltins(config.dataDir, 'skills');
    for (const [path, asset] of Object.entries(assets))
      expect(await readFile(join(first, ...path.split('/')), 'utf8')).toBe(asset);
    expect(await materializeBuiltins(config.dataDir, 'skills')).toBe(first);
  } finally {
    await f.cleanup();
  }
});
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
    await writeFile(join(root, 'device-automation', 'references', 'interfaces.md'), 'modified');
    await expect(materializeBuiltins(f.config.dataDir, 'skills')).rejects.toThrow('modified');
  } finally {
    await f.cleanup();
  }
});
