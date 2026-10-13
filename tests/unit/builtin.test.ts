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
test('formal built-in skill loads host-independent interface guidance and preserves asset integrity', async () => {
  const f = await fixture();
  try {
    const assets = await collectBuiltinAssets('skills');
    const config = { ...f.config, skillRoots: [], builtinSkills: true, resourceLimitBytes: 16384 };
    const skills = new Skills(config);
    const catalog = await skills.discover();
    expect(catalog.map((s) => s.name)).toEqual(['device-automation']);
    expect(catalog[0]!.description).toContain('下发自动化设备并运行');
    expect(catalog[0]!.metadata.compatibility).toContain('需要可调用的设备接口');
    expect(catalog[0]!.metadata.compatibility).not.toContain('builtin');
    expect(skills.source('device-automation')).toBe('built-in');
    const content = await skills.load('device-automation');
    expect(content).toContain('根据需求匹配模板并运行自动化设备');
    expect(content).toContain('当前环境提供的');
    expect(content).toContain('references/interfaces.md');
    expect(content).toContain('模板推荐草案——参数尚未确认，不可下发运行');
    expect(content).not.toContain('scripts/device.js');
    expect(content).not.toContain('validate-template');
    expect(content).toContain('仅复用满足需求的已有模板');
    expect(content).toContain('模板文件名从知识资料匹配结果或用户提供的信息取得');
    expect(content).toContain('不查询、列举或读取设备模板目录');
    expect(content).toContain('暂不支持生成、创建或修改模板');
    expect(content).toContain('不调用任务控制操作');
    const interfaces = await skills.read('device-automation', 'references/interfaces.md');
    expect(interfaces).toContain('不绑定特定 Agent 或工具名称');
    expect(interfaces).toContain('由接口部署配置决定');
    expect(interfaces).toContain('测量提交');
    expect(interfaces).toContain('templateFile');
    expect(interfaces).toContain('文件名');
    expect(interfaces).toContain('接口没有样品标识字段');
    expect(content).toContain('不询问、生成或下发样品编号');
    expect(content).not.toContain('sampleId');
    expect(interfaces).not.toContain('sampleId');
    for (const guidance of [content, interfaces])
      expect(guidance).not.toMatch(
        /save-template|control-measurement|templateId|list-templates|get-template/,
      );
    expect(interfaces).not.toContain('validate-template');
    for (const guidance of [content, interfaces, catalog[0]!.metadata.compatibility]) {
      expect(guidance).not.toMatch(
        /wiki|execute_script|`read`|\.auto-agent|AUTO_AGENT_|scriptEnv|模拟|合成|sim-analyzer/i,
      );
    }
    expect(content).toContain('契约描述操作和数据约定，不代表设备已经连接');
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
