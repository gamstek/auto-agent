import { test, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { fixture } from '../helpers';
const binary = resolve('dist', process.platform === 'win32' ? 'auto-agent.exe' : 'auto-agent');
test.skipIf(!process.env.AUTO_AGENT_TEST_BINARY)(
  'compiled binary serves authenticated sessions and works outside repository cwd',
  async () => {
    const f = await fixture();
    const file = join(f.dir, 'config.json');
    await writeFile(file, JSON.stringify(f.config));
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
      const cli = Bun.spawn([binary, '--config', file], {
        cwd: f.dir,
        env: { ...process.env, AUTO_AGENT_TOKEN: f.config.token },
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: new Blob(['/exit\n']),
      });
      expect(await cli.exited).toBe(0);
      expect(await new Response(cli.stdout).text()).toContain('Session: ');
    } finally {
      proc.kill();
      await proc.exited;
      await f.cleanup();
    }
  },
  30000,
);
