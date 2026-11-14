import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import glob from '@coraxjs/core/tools/glob';
import grep from '@coraxjs/core/tools/grep';
import bash from '@coraxjs/core/tools/bash';
import { createHostSession } from '../../corax/lib/host/session';
import { toShellPath } from '../../corax/lib/host/paths';

test('native host environment runs real programs and shares native files with Corax aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent host 量仔-'));
  const workspace = join(root, 'workspace'),
    skills = join(root, 'skills');
  await mkdir(skills);
  await writeFile(join(skills, 'reference.md'), '# Native skill reference');
  const host = await createHostSession({ workspace, skills });
  try {
    await host.sandbox.writeTextFile({
      path: '/workspace/nested/file.txt',
      content: 'native-shared-file',
    });
    assert.equal(await readFile(join(workspace, 'nested/file.txt'), 'utf8'), 'native-shared-file');
    const shell = await host.sandbox.run({
      command:
        'cat \'/workspace/nested/file.txt\'; printf \'\\n%s|%s|%s\' "$HOST_TEST_SENTINEL" "${AUTO_AGENT_TOKEN-unset}" "${AUTO_AGENT_API_KEY-unset}"',
      env: {
        HOST_TEST_SENTINEL: 'full-host-environment',
        AUTO_AGENT_TOKEN: 'private-fixture',
        AUTO_AGENT_API_KEY: 'private-fixture',
      },
    });
    assert.equal(shell.exitCode, 0, shell.stderr);
    assert.match(shell.stdout, /native-shared-file\s+full-host-environment\|unset\|unset/);
    const node = `'${toShellPath(process.execPath).replaceAll("'", "'\\''")}'`;
    const native = await host.sandbox.run({
      command: `${node} -e 'process.stdout.write("NATIVE-" + process.platform)'`,
      // Only the explicitly addressed host program and bundled shell are needed.
      env: process.platform === 'win32' ? { PATH: dirname(process.execPath) } : undefined,
    });
    assert.equal(native.exitCode, 0, native.stderr);
    assert.equal(native.stdout, `NATIVE-${process.platform}`);
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside the workspace');
    assert.equal(
      await host.sandbox.readTextFile({ path: toShellPath(outside) }),
      'outside the workspace',
    );
    assert.equal(
      await host.sandbox.readTextFile({ path: '$HOME/.agents/skills/reference.md' }),
      '# Native skill reference',
    );
    const failure = await host.sandbox.run({ command: 'printf native-stderr >&2; exit 7' });
    assert.equal(failure.exitCode, 7);
    assert.match(failure.stderr, /native-stderr/);
    await host.close();
    assert.equal(await readFile(outside, 'utf8'), 'outside the workspace');
    assert.equal(await readFile(join(workspace, 'nested/file.txt'), 'utf8'), 'native-shared-file');
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Corax native glob and grep execute against real host files without Git Bash', async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-agent 量仔's search-"));
  const host = await createHostSession({ workspace: root, skills: root });
  const originalPath = process.env.PATH;
  const originalMixedPath = process.env.Path;
  try {
    if (process.platform === 'win32') {
      delete process.env.Path;
      process.env.PATH = dirname(process.execPath);
      const probe = await host.sandbox.run({ command: 'command -v bash' });
      assert.equal(
        probe.stdout.trim(),
        'bash',
        'Only the bundled BusyBox applet may be discovered',
      );
    }
    await host.sandbox.writeTextFile({
      path: '/workspace/nested/中文 sample.txt',
      content: 'line one\nneedle 量仔\nlast line\n',
    });
    const context = { getSandbox: async () => host.sandbox } as never;
    const files = await glob.execute!({ pattern: '**/*.txt' }, context);
    assert.ok('count' in files);
    assert.equal(files.count, 1);
    assert.match(files.content, /中文 sample\.txt/);
    const matches = await grep.execute!(
      {
        pattern: 'needle 量仔',
        glob: '*.txt',
        path: `${process.platform === 'win32' ? '/' : ''}${toShellPath(root)}`,
      },
      context,
    );
    assert.ok('matchCount' in matches);
    assert.equal(matches.matchCount, 1);
    assert.match(matches.content, /:2:needle 量仔/);
    const empty = await grep.execute!({ pattern: 'definitely-not-in-file' }, context);
    assert.ok('matchCount' in empty);
    assert.equal(empty.matchCount, 0);
    await assert.rejects(async () => {
      await grep.execute!({ pattern: '[' }, context);
    }, /grep failed/);
    assert.equal(
      await readFile(join(root, 'nested/中文 sample.txt'), 'utf8'),
      'line one\nneedle 量仔\nlast line\n',
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalMixedPath !== undefined) process.env.Path = originalMixedPath;
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('host cancellation stops only the owned command and keeps host files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent-host-cancel-'));
  const host = await createHostSession({ workspace: root, skills: root });
  try {
    await writeFile(join(root, 'keep.txt'), 'keep');
    const abort = new AbortController();
    const node = `'${toShellPath(process.execPath).replaceAll("'", "'\\''")}'`;
    const task = await host.sandbox.spawn({
      command: `${node} -e 'require("node:fs").writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000)'`,
      abortSignal: abort.signal,
    });
    let childPid = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const pid = await readFile(join(root, 'child.pid'), 'utf8').catch(() => '');
      if (pid) {
        childPid = Number(pid);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(childPid > 0, 'The real child process must start before testing cancellation');
    abort.abort(new Error('fixture cancellation'));
    await assert.rejects(Promise.resolve(task.wait()), /fixture cancellation/);
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      try {
        process.kill(childPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        alive = false;
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      alive,
      false,
      'Cancellation must terminate native descendants, not just the shell',
    );
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'Corax native long commands retain their running-job output on the real host',
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-agent-host-job-'));
    const host = await createHostSession({ workspace: root, skills: root });
    try {
      const result = await bash.execute!({ command: 'sleep 32; printf LONG-HOST-JOB-OK' }, {
        getSandbox: async () => host.sandbox,
      } as never);
      assert.ok('status' in result);
      assert.equal(result.status, 'running');
      if (result.status !== 'running') return;
      for (let attempt = 0; attempt < 50; attempt++) {
        if ((await host.sandbox.readTextFile({ path: `${result.outputDirectory}/exit` })) !== null)
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(
        (await host.sandbox.readTextFile({ path: `${result.outputDirectory}/exit` }))?.trim(),
        '0',
      );
      assert.equal(
        await host.sandbox.readTextFile({ path: `${result.outputDirectory}/stdout` }),
        'LONG-HOST-JOB-OK',
      );
      await host.sandbox.removePath({ path: result.outputDirectory, recursive: true, force: true });
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
