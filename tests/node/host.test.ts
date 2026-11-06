import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSession } from '../../lib/host/session';
import { toShellPath } from '../../lib/host/paths';

test('ShellJS host environment runs real programs and shares native files with Corax aliases', async () => {
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

test('host cancellation stops only the owned command and keeps host files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent-host-cancel-'));
  const host = await createHostSession({ workspace: root, skills: root });
  try {
    await writeFile(join(root, 'keep.txt'), 'keep');
    const abort = new AbortController();
    const task = await host.sandbox.spawn({ command: 'sleep 30', abortSignal: abort.signal });
    abort.abort(new Error('fixture cancellation'));
    await assert.rejects(Promise.resolve(task.wait()), /fixture cancellation/);
    assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
