import { test, expect } from 'bun:test';
import { resolve, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../helpers';
const dev = resolve('scripts', 'dev.ts');
test('development selects repository config without touching user config and explicit paths win', async () => {
  const child = Bun.spawn([Bun.argv[0], dev, 'serve'], {
    env: { ...process.env, AUTO_AGENT_TOKEN: 'short' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain('AUTO_AGENT_TOKEN');
  const diagnostic = await new Response(child.stdout).text();
  expect(diagnostic).toContain('Selected configuration: ' + resolve('examples', 'config.json'));
  const f = await fixture();
  try {
    const file = join(f.dir, 'config.json');
    await writeFile(file, JSON.stringify({ ...f.config, skillRoots: [] }));
    const override = Bun.spawn([Bun.argv[0], dev, '--config', file], {
      cwd: f.dir,
      env: { ...process.env },
      stdin: new Blob(['/exit\n']),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = await new Response(override.stdout).text();
    expect(await override.exited).toBe(0);
    expect(output).toContain('Mode: development');
    expect(output).toContain('Configuration: ' + file);
    expect(output).toContain('Data: ' + f.config.dataDir);
    const skills = Bun.spawn(
      [
        Bun.argv[0],
        '-e',
        `import {loadConfig} from ${JSON.stringify(resolve('src', 'config', 'index.ts'))}; import {Skills} from ${JSON.stringify(resolve('src', 'skills', 'index.ts'))}; const config=await loadConfig(${JSON.stringify(resolve('examples', 'config.json'))},false,true);console.log(JSON.stringify((await new Skills(config).discover()).map(skill=>skill.name)));`,
      ],
      { cwd: f.dir, stdout: 'pipe', stderr: 'pipe' },
    );
    const catalog = await new Response(skills.stdout).text();
    expect(await skills.exited).toBe(0);
    expect(JSON.parse(catalog).sort()).toEqual(['device-automation', 'hello-world', 'sum-values']);
  } finally {
    await f.cleanup();
  }
});
