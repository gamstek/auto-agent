import { test, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { fixture } from '../helpers';
const entry = resolve('src', 'index.ts');
async function invoke(args: string[], token?: string) {
  const env = { ...process.env };
  delete env.AUTO_AGENT_TOKEN;
  delete env.AUTO_AGENT_API_KEY;
  if (token !== undefined) env.AUTO_AGENT_TOKEN = token;
  const child = Bun.spawn([Bun.argv[0], entry, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const stderr = await new Response(child.stderr).text();
  return { code: await child.exited, stderr };
}
test('startup explains missing and short bearer tokens without revealing supplied values', async () => {
  for (const token of [undefined, 'short-secret']) {
    const result = await invoke(['serve'], token);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('AUTO_AGENT_TOKEN');
    expect(result.stderr).toContain('at least 16 characters');
    expect(result.stderr).not.toContain('Internal operation failed');
    if (token) expect(result.stderr).not.toContain(token);
  }
});
test('source server starts and responds when a valid token and configuration are provided', async () => {
  const f = await fixture();
  const path = join(f.dir, 'config.json');
  await writeFile(path, JSON.stringify(f.config));
  const child = Bun.spawn([Bun.argv[0], entry, 'serve', '--config', path], {
    env: { ...process.env, AUTO_AGENT_TOKEN: f.config.token },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = child.stdout.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('startup timeout')), 10000);
      }),
    ]);
    clearTimeout(timer);
    let startup = new TextDecoder().decode(first.value);
    while (!startup.split('\n').some((line) => line.startsWith('{'))) {
      const next = await reader.read();
      if (next.done) throw new Error('Server exited before listening');
      startup += new TextDecoder().decode(next.value);
    }
    const info = JSON.parse(startup.split('\n').find((line) => line.startsWith('{'))!);
    expect((await fetch(info.url + '/global/health')).status).toBe(200);
    await reader.cancel();
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    await f.cleanup();
  }
});
test('startup wiki catalog uses the same source labels as skills without exposing source hashes', async () => {
  const f = await fixture();
  const root = join(f.dir, 'wiki');
  await mkdir(root);
  await writeFile(join(root, 'example.md'), 'Example knowledge');
  const configPath = join(f.dir, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      ...f.config,
      builtinSkills: true,
      builtinWiki: true,
      wikiRoots: [root],
      resourceLimitBytes: 65536,
    }),
  );
  const child = Bun.spawn([Bun.argv[0], entry, '--config', configPath], {
    env: { ...process.env, AUTO_AGENT_API_KEY: '' },
    stdin: new Blob(['/exit\n']),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('Skills: device-automation (built-in)');
    expect(stderr).toContain(
      'Wiki: 比表面积及孔径分析仪自动化模板.md (built-in), example.md (configured)',
    );
    expect(stderr).toContain('Wiki knowledge: unbuilt');
    expect(stderr).not.toContain('external-');
    expect(stderr).not.toContain('Built-in wiki:');
  } finally {
    await f.cleanup();
  }
});

test('configuration failures identify fields without leaking their values', async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({ token: f.config.token, port: 'sensitive-invalid-value' }),
    );
    const invalid = await invoke(['serve', '--config', path]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain('port');
    expect(invalid.stderr).not.toContain('sensitive-invalid-value');
    await writeFile(path, 'not-json');
    expect((await invoke(['serve', '--config', path], f.config.token)).stderr).toContain(
      'readable JSON',
    );
  } finally {
    await f.cleanup();
  }
});

test('no-token cannot be enabled by configuration and rejects remote binding', async () => {
  const f = await fixture();
  try {
    const path = join(f.dir, 'config.json');
    await writeFile(path, JSON.stringify({ noToken: true }));
    expect((await invoke(['serve', '--config', path])).stderr).toContain('AUTO_AGENT_TOKEN');
    await writeFile(path, JSON.stringify({ host: '0.0.0.0', allowRemote: true }));
    const remote = await invoke(['serve', '--config', path, '--no-token']);
    expect(remote.code).toBe(1);
    expect(remote.stderr).toContain('loopback');
  } finally {
    await f.cleanup();
  }
});
