import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { fixture } from '../helpers';

test('application module can be imported without running startup', async () => {
  const f = await fixture();
  try {
    const module = resolve('src', 'app.ts');
    const child = Bun.spawn(
      [
        Bun.argv[0],
        '-e',
        `const { main } = await import(${JSON.stringify(module)}); console.log(typeof main);`,
      ],
      { cwd: f.dir, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(await new Response(child.stdout).text()).toBe('function\n');
    expect(await new Response(child.stderr).text()).toBe('');
    expect(await child.exited).toBe(0);
  } finally {
    await f.cleanup();
  }
});
