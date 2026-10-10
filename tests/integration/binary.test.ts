import { test, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fixture } from '../helpers';
import { collectBuiltinAssets } from '../../src/skill/builtin-assets';
const binary = process.env.AUTO_AGENT_TEST_BINARY_PATH
  ? resolve(process.env.AUTO_AGENT_TEST_BINARY_PATH)
  : resolve('dist', process.platform === 'win32' ? 'auto-agent.exe' : 'auto-agent');
test.skipIf(!process.env.AUTO_AGENT_TEST_BINARY)(
  'compiled binary serves authenticated sessions and works outside repository cwd',
  async () => {
    const f = await fixture();
    try {
      const help = Bun.spawn([binary, '--help'], { cwd: f.dir, stdout: 'pipe', stderr: 'pipe' });
      expect(await new Response(help.stdout).text()).toContain('auto-agent [serve]');
      expect(await help.exited).toBe(0);
      const invalid = Bun.spawn([binary, '--config', join(f.dir, 'missing.json')], {
        cwd: f.dir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await new Response(invalid.stderr).text()).toContain('Cannot read configuration');
      expect(await invalid.exited).toBe(1);
    } catch (error) {
      await f.cleanup();
      throw error;
    }
    const file = join(f.dir, 'config.json');
    await writeFile(file, JSON.stringify({ ...f.config, skillRoots: [], builtinSkills: true }));
    const proc = Bun.spawn([binary, 'serve', '--config', file], {
      cwd: f.dir,
      env: { ...process.env, AUTO_AGENT_TOKEN: f.config.token },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const reader = proc.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('startup timeout')), 10000),
        ),
      ]);
      let startup = new TextDecoder().decode(first.value);
      while (!startup.split('\n').some((line) => line.startsWith('{'))) {
        const next = await reader.read();
        if (next.done) throw new Error('Server exited before listening');
        startup += new TextDecoder().decode(next.value);
      }
      const info = JSON.parse(startup.split('\n').find((line) => line.startsWith('{'))!);
      expect(startup).not.toContain('[info]');
      const builtinsRoot = join(f.config.dataDir, 'builtin-skills');
      const versions = await readdir(builtinsRoot);
      expect(versions).toHaveLength(1);
      for (const [path, content] of Object.entries(await collectBuiltinAssets()))
        expect(await readFile(join(builtinsRoot, versions[0]!, ...path.split('/')), 'utf8')).toBe(
          content,
        );
      const base = info.url;
      await reader.cancel();
      expect((await fetch(base + '/global/health')).status).toBe(200);
      expect((await fetch(base + '/session')).status).toBe(401);
      const headers = {
        Authorization: `Bearer ${f.config.token}`,
        'Content-Type': 'application/json',
      };
      const session = await (
        await fetch(base + '/session', { method: 'POST', headers, body: '{}' })
      ).json();
      expect(session.id).toBeTruthy();
      proc.kill();
      await proc.exited;
      expect(await new Response(proc.stderr).text()).toContain('device-automation (built-in)');
      const cli = Bun.spawn([binary, '--config', file], {
        cwd: f.dir,
        env: { ...process.env, AUTO_AGENT_TOKEN: f.config.token },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: new Blob(['/exit\n']),
      });
      expect(await cli.exited).toBe(0);
      expect(await new Response(cli.stdout).text()).toBe('');
      expect(await new Response(cli.stderr).text()).toContain('Session: ');
    } finally {
      proc.kill();
      await proc.exited;
      await f.cleanup();
    }
  },
  30000,
);
