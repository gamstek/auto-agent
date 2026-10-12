import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../../src/config';
import { ScriptExecutor } from '../../src/execution';
import { ANCHOR_FLAG, SCRIPT_FLAG, runtimeCommand } from '../../src/execution/runtime';
import { Skills } from '../../src/skill';

// Keep test files in the repository, not OS temporary directories.
async function setup() {
  const dir = resolve(`.embedded-runtime-test-${randomUUID()}`);
  const root = join(dir, 'skills');
  const skill = join(root, 'runtime-fixture');
  const scripts = join(skill, 'scripts');
  try {
    await mkdir(scripts, { recursive: true });
    // Extracted skill directories do not inherit the repository's ESM package scope.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: runtime-fixture\ndescription: Runtime fixture\n---\nRun scripts/main.js.\n',
    );
    const configPath = join(dir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        dataDir: dir,
        skillRoots: [root],
        builtinSkills: false,
        builtinWiki: false,
        scriptTimeoutMs: 20000,
        scriptEnv: { FIXTURE_VALUE: 'allowed' },
      }),
    );
    const config = await loadConfig(configPath, true, true);
    const skills = new Skills(config);
    await skills.discover();
    return {
      dir,
      skill,
      scripts,
      config,
      skills,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

const request = (path: string, args: string[] = []) => ({
  skill: 'runtime-fixture',
  path: `scripts/${path}`,
  args,
});
const signal = () => new AbortController().signal;
// The Windows tracker uses the native absolute PowerShell path; no PATH entries are needed.
const osPath = '';
async function withoutRuntimePath<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = osPath;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

test('bare node automatically falls back with empty PATH, preserving argv, cwd, CommonJS and sanitized env', async () => {
  const f = await setup();
  try {
    await writeFile(
      join(f.scripts, 'main.js'),
      `const fs = require('node:fs'); const path = require('node:path'); console.log(JSON.stringify({argv:process.argv, cwd:process.cwd(), env:process.env, exists:fs.existsSync(path.resolve('SKILL.md'))}));`,
    );
    const args = ['a; echo injected', 'space value', '中文', '--auto-agent-internal-anchor'];
    const result = await withoutRuntimePath(() =>
      new ScriptExecutor(f.config, f.skills).execute(request('main.js', args), signal()),
    );
    expect(result.status).toBe('completed');
    expect(result.stderr).toBe('');
    const data = JSON.parse(result.stdout);
    expect(data.argv).toEqual([process.execPath, join(f.scripts, 'main.js'), ...args]);
    expect(data.cwd).toBe(f.skill);
    expect(data.exists).toBe(true);
    expect(data.env.FIXTURE_VALUE).toBe('allowed');
    expect(data.env.AUTO_AGENT_API_KEY).toBeUndefined();
    expect(data.env.AUTO_AGENT_TOKEN).toBeUndefined();
    expect(data.env.NODE_OPTIONS).toBeUndefined();
    expect(data.env.PATH).toBe(osPath);
    expect(f.config.interpreters['.js']).toBe('node');
    const nodeExe = await withoutRuntimePath(() =>
      new ScriptExecutor({ ...f.config, interpreters: { '.js': 'node.exe' } }, f.skills).execute(
        request('main.js', args),
        signal(),
      ),
    );
    expect(nodeExe.status).toBe('completed');
    expect(JSON.parse(nodeExe.stdout).argv).toEqual(data.argv);
    await expect(
      new ScriptExecutor(f.config, f.skills).execute(
        { skill: 'runtime-fixture', path: '../outside.js' },
        signal(),
      ),
    ).rejects.toThrow();
    const missing = await withoutRuntimePath(() =>
      new ScriptExecutor(
        { ...f.config, interpreters: { '.js': 'missing-auto-agent-interpreter' } },
        f.skills,
      ).execute(request('main.js'), signal()),
    );
    expect(missing.status).toBe('failed');
  } finally {
    await f.cleanup();
  }
}, 60000);

test.skipIf(!Bun.which('node'))(
  'bare node prefers installed Node and never retries script failures',
  async () => {
    const f = await setup();
    try {
      await writeFile(
        join(f.scripts, 'main.js'),
        'console.log(JSON.stringify({bun:!!process.versions.bun}));',
      );
      const executor = new ScriptExecutor(f.config, f.skills);
      const preferred = await executor.execute(request('main.js'), signal());
      expect(preferred.status).toBe('completed');
      expect(JSON.parse(preferred.stdout).bun).toBe(false);
      await writeFile(
        join(f.scripts, 'failure.js'),
        "require('node:fs').appendFileSync('runs.txt','x'); console.log('bun:'+!!process.versions.bun); process.exit(7);",
      );
      const failed = await executor.execute(request('failure.js'), signal());
      expect(failed.status).toBe('failed');
      expect(failed.exitCode).toBe(7);
      expect(failed.stdout.trim()).toBe('bun:false');
      expect(await readFile(join(f.skill, 'runs.txt'), 'utf8')).toBe('x');
      const explicit = await new ScriptExecutor(
        { ...f.config, interpreters: { '.js': 'builtin' } },
        f.skills,
      ).execute(request('main.js'), signal());
      expect(explicit.status).toBe('completed');
      expect(JSON.parse(explicit.stdout).bun).toBe(true);
      const missingPath = await withoutRuntimePath(() =>
        new ScriptExecutor(
          { ...f.config, interpreters: { '.js': join(f.dir, 'missing-node.exe') } },
          f.skills,
        ).execute(request('main.js'), signal()),
      );
      expect(missingPath.status).toBe('failed');
      expect(missingPath.stdout).toBe('');
    } finally {
      await f.cleanup();
    }
  },
  60000,
);

test('automatic fallback bounds output and cleans anchored descendants on timeout and cancellation', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.scripts, 'large.js'), `console.log('x'.repeat(100000));`);
    const large = await withoutRuntimePath(() =>
      new ScriptExecutor({ ...f.config, outputLimitBytes: 512 }, f.skills).execute(
        request('large.js'),
        signal(),
      ),
    );
    expect(large.status).toBe('output_limit');
    expect(Buffer.byteLength(large.stdout) + Buffer.byteLength(large.stderr)).toBeLessThanOrEqual(
      512,
    );
    // Self-spawn the same internal script, never an external runtime or an eval string.
    await writeFile(
      join(f.scripts, 'wait.js'),
      `const {spawn}=require('node:child_process'); const fs=require('node:fs'); if(process.argv[2]==='descendant'){setInterval(()=>{},1000)} else {const child=spawn(process.execPath, ${JSON.stringify(runtimeCommand(SCRIPT_FLAG)[1])}.concat(process.argv[1], 'descendant'), {stdio:'ignore'}); fs.writeFileSync('pids.json',JSON.stringify([process.pid,child.pid])); console.log(process.pid,child.pid); setInterval(()=>{},1000)}`,
    );
    for (const mode of ['timeout', 'cancelled'] as const) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Give CIM time to establish the anchor and observe the descendant.
      if (mode === 'cancelled') timer = setTimeout(() => controller.abort(), 6500);
      const result = await withoutRuntimePath(() =>
        new ScriptExecutor(
          { ...f.config, scriptTimeoutMs: mode === 'timeout' ? 6500 : 20000 },
          f.skills,
        ).execute(request('wait.js'), controller.signal),
      );
      clearTimeout(timer);
      expect(result.status).toBe(mode);
      const pids = JSON.parse(await readFile(join(f.skill, 'pids.json'), 'utf8')) as number[];
      expect(pids.length).toBe(2);
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      await rm(join(f.skill, 'pids.json'));
    }
  } finally {
    await f.cleanup();
  }
}, 90000);

test('automatic fallback keeps the global concurrency slot and queued cancellation semantics', async () => {
  const f = await setup();
  try {
    await writeFile(
      join(f.scripts, 'main.js'),
      "setTimeout(() => console.log('first-only'), 100);",
    );
    const executor = new ScriptExecutor({ ...f.config, maxConcurrent: 1 }, f.skills);
    await withoutRuntimePath(async () => {
      const first = executor.execute(request('main.js'), signal());
      const controller = new AbortController();
      const queued = executor.execute(request('not-present.js'), controller.signal);
      controller.abort();
      expect(await queued).toEqual({ status: 'cancelled', stdout: '', stderr: '', exitCode: null });
      const result = await first;
      expect(result.status).toBe('completed');
      expect(result.stdout.trim()).toBe('first-only');
    });
  } finally {
    await f.cleanup();
  }
}, 30000);

test('external interpreter mappings also use the embedded Windows anchor', async () => {
  const f = await setup();
  try {
    const windows = process.platform === 'win32';
    const filename = windows ? 'external.ps1' : 'external.js';
    await writeFile(
      join(f.scripts, filename),
      windows
        ? "Write-Output ('external:' + $args[0])"
        : "console.log('external:' + process.argv[2]);",
    );
    const command = windows
      ? join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : process.execPath;
    const executor = new ScriptExecutor(
      { ...f.config, interpreters: { [windows ? '.ps1' : '.js']: command } },
      f.skills,
    );
    const result = await withoutRuntimePath(() =>
      executor.execute(request(filename, ['literal-value']), signal()),
    );
    expect(result.status).toBe('completed');
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('external:literal-value');
  } finally {
    await f.cleanup();
  }
}, 30000);

const entries: [string, [string, string[]]][] = [['source', runtimeCommand(SCRIPT_FLAG)]];
// Match the integration suite: enable flag and optional isolated artifact path are separate.
if (process.env.AUTO_AGENT_TEST_BINARY)
  entries.push([
    'compiled',
    [
      resolve(
        process.env.AUTO_AGENT_TEST_BINARY_PATH ??
          join('dist', process.platform === 'win32' ? 'auto-agent.exe' : 'auto-agent'),
      ),
      [SCRIPT_FLAG],
    ],
  ]);
for (const [name, [executable, prefix]] of entries) {
  test(`${name} internal dispatch runs an extracted instrument script without app startup`, async () => {
    const f = await setup();
    try {
      const script = join(f.scripts, 'instrument.js');
      await writeFile(
        script,
        await readFile(resolve('skills', 'device-automation', 'scripts', 'instrument.js')),
      );
      const child = Bun.spawn([executable, ...prefix, script, 'list'], {
        cwd: f.skill,
        env: { PATH: '', SystemRoot: process.env.SystemRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(JSON.parse(stdout).devices.length).toBeGreaterThan(0);
      expect(await Bun.file(join(f.dir, 'data', 'agent.db')).exists()).toBe(false);
    } finally {
      await f.cleanup();
    }
  }, 20000);

  test(`${name} anchor IPC reports exit, stays pinned, and releases on stdin EOF`, async () => {
    const f = await setup();
    try {
      const anchorPrefix = prefix.slice(0, -1).concat(ANCHOR_FLAG);
      const anchor = spawn(executable, anchorPrefix, {
        cwd: f.skill,
        env: { PATH: '', SystemRoot: process.env.SystemRoot },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });
      let stderr = '';
      anchor.stderr!.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      const closed = new Promise<void>((resolve) => anchor.once('close', () => resolve()));
      try {
        const script = join(f.scripts, 'main.js');
        await writeFile(script, `console.log('script-only');`);
        const message = new Promise<unknown>((resolve, reject) => {
          anchor.once('message', resolve);
          anchor.once('error', reject);
          anchor.once('exit', () =>
            reject(new Error('Anchor exited before reporting script exit: ' + stderr)),
          );
        });
        anchor.send({ command: executable, args: [...prefix, script], cwd: f.skill });
        expect(await message).toEqual({ exitCode: 0 });
        await Bun.sleep(100);
        expect(anchor.exitCode).toBeNull();
        expect(() => process.kill(anchor.pid!, 0)).not.toThrow();
        anchor.stdin!.end();
        await closed;
        expect(stderr).toBe('');
      } finally {
        if (anchor.exitCode === null && anchor.signalCode === null) anchor.kill();
        await closed;
      }
    } finally {
      await f.cleanup();
    }
  }, 20000);
}
