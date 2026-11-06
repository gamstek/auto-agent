import { expect, test } from 'bun:test';
import { pnpmCommand } from '../../scripts/shared/pnpm';
import { resolve } from 'node:path';

test('workspace build launcher invokes the same pnpm without shell quoting', async () => {
  const agent = process.env.npm_config_user_agent ?? '';
  expect(agent).toStartWith('pnpm/');
  const child = Bun.spawn(pnpmCommand(['--version']), { stdout: 'pipe', stderr: 'pipe' });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output.trim()).toBe(agent.split(' ')[0]!.slice('pnpm/'.length));
});

test('nested desktop tasks resolve the root workspace explicitly without filtering it out', async () => {
  const root = resolve(import.meta.dir, '../..');
  const child = Bun.spawn(
    pnpmCommand(['--workspace-root', 'exec', 'bun', '-e', 'console.log(process.cwd())']),
    {
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  expect(output.trim()).toBe(root);
});
