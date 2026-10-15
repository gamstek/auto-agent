import { test, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureDefaultConfig, loadConfig } from '../../src/config';
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

test('config defaults prefer Node and use per-request input/output token limits', async () => {
  const home = resolve(`.config-defaults-test-${randomUUID()}`);
  try {
    const created = await ensureDefaultConfig(home);
    const template = await Bun.file(created.path).json();
    expect(template.interpreters['.js']).toBe('node');
    expect(template.maxOutputTokens).toBe(16000);
    expect(template.maxInputTokens).toBe(1000000);
    expect(template.webAllowPrivateAddresses).toBe(true);
    expect(template.scriptEnv).toEqual({
      CLIMBER_SERVICE_URL: 'http://127.0.0.1:19181',
      CLIMBER_TIMEOUT_MS: '5000',
    });
    const config = await loadConfig(created.path, true, true);
    expect(config.scriptEnv).toEqual(template.scriptEnv);
    expect(config.interpreters['.js']).toBe('node');
    expect(config.maxOutputTokens).toBe(16000);
    expect(config.maxInputTokens).toBe(1000000);
    await writeFile(created.path, '{}');
    const defaults = await loadConfig(created.path, true, true);
    expect(defaults.interpreters['.js']).toBe('node');
    expect(defaults.maxOutputTokens).toBe(16000);
    expect(defaults.maxInputTokens).toBe(1000000);
    expect(defaults.webAllowPrivateAddresses).toBe(true);
    await writeFile(created.path, JSON.stringify({ webAllowPrivateAddresses: false }));
    expect((await loadConfig(created.path, true, true)).webAllowPrivateAddresses).toBe(false);
    await writeFile(created.path, JSON.stringify({ webAllowPrivateAddresses: true }));
    expect((await loadConfig(created.path, true, true)).webAllowPrivateAddresses).toBe(true);
    for (const webAllowPrivateAddresses of ['true', 1, null]) {
      await writeFile(created.path, JSON.stringify({ webAllowPrivateAddresses }));
      await expect(loadConfig(created.path, true, true)).rejects.toThrow(
        'webAllowPrivateAddresses',
      );
    }
    await writeFile(
      created.path,
      JSON.stringify({
        interpreters: { '.js': 'node' },
        maxOutputTokens: 5000,
        maxInputTokens: 1000,
      }),
    );
    const explicit = await loadConfig(created.path, true, true);
    expect(explicit.interpreters['.js']).toBe('node');
    expect(explicit.maxOutputTokens).toBe(5000);
    expect(explicit.maxInputTokens).toBe(1000);
    await writeFile(created.path, JSON.stringify({ contextWindow: 12000, maxOutputTokens: 2000 }));
    expect((await loadConfig(created.path, true, true)).maxInputTokens).toBe(10000);
    await writeFile(
      created.path,
      JSON.stringify({ contextWindow: 12000, maxInputTokens: 9000, maxOutputTokens: 2000 }),
    );
    expect((await loadConfig(created.path, true, true)).maxInputTokens).toBe(9000);
    for (const invalid of [
      { contextWindow: 2000, maxOutputTokens: 2000 },
      { contextWindow: 1000, maxOutputTokens: 2000 },
      { contextWindow: 12000, maxInputTokens: 11000, maxOutputTokens: 2000 },
      { contextWindow: 0 },
      { contextWindow: '12000' },
    ]) {
      await writeFile(created.path, JSON.stringify(invalid));
      await expect(loadConfig(created.path, true, true)).rejects.toThrow('contextWindow');
    }
    for (const field of ['maxTokens', 'maxContextTokens', 'contextWindowTokens']) {
      await writeFile(created.path, JSON.stringify({ [field]: 1000 }));
      await expect(loadConfig(created.path, true, true)).rejects.toThrow(
        'replaced by maxInputTokens and maxOutputTokens',
      );
    }
    for (const maxInputTokens of [0, -1, 1.5, '16000']) {
      await writeFile(created.path, JSON.stringify({ maxInputTokens }));
      await expect(loadConfig(created.path, true, true)).rejects.toThrow('maxInputTokens');
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
