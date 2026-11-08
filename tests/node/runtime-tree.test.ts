import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { preparePublishedTree } from '../../desktop/scripts/runtime-tree';

test('published runtime drops pnpm launchers without following links or removing Node entry points', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'auto-agent-runtime-tree-'));
  try {
    const runtime = join(temporary, 'runtime');
    const modules = join(runtime, 'node_modules');
    const packageRoot = join(modules, '@coraxjs/core');
    const bin = join(modules, '.bin');
    const nestedBin = join(packageRoot, 'node_modules/.bin');
    const external = join(temporary, 'external');
    for (const path of [
      bin,
      nestedBin,
      join(packageRoot, 'bin'),
      external,
      join(runtime, 'assets/.bin'),
    ])
      await mkdir(path, { recursive: true });
    const entryPoint = join(packageRoot, 'bin/corax.js');
    await writeFile(entryPoint, 'console.log("fixed-node-entry-ok");');
    await writeFile(join(packageRoot, 'bin/corax.js.map'), 'dependency-map');
    await writeFile(join(runtime, 'assets/evidence.map'), 'authored-asset');
    await writeFile(join(runtime, 'assets/.bin/keep.txt'), 'not-a-pnpm-launcher');
    await writeFile(join(external, 'keep.txt'), 'external-data');
    await writeFile(join(bin, 'corax.cmd'), 'unused-windows-launcher');
    await writeFile(join(nestedBin, 'nested.cmd'), 'unused-nested-launcher');
    if (process.platform !== 'win32')
      await symlink('../@coraxjs/core/bin/corax.js', join(bin, 'corax'));
    await symlink(external, join(bin, 'external'), 'junction');

    assert.equal(await preparePublishedTree(runtime), Buffer.byteLength('dependency-map'));
    await assert.rejects(lstat(bin), { code: 'ENOENT' });
    await assert.rejects(lstat(nestedBin), { code: 'ENOENT' });
    await assert.rejects(lstat(join(packageRoot, 'bin/corax.js.map')), { code: 'ENOENT' });
    assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'external-data');
    assert.equal(await readFile(join(runtime, 'assets/evidence.map'), 'utf8'), 'authored-asset');
    assert.equal(
      await readFile(join(runtime, 'assets/.bin/keep.txt'), 'utf8'),
      'not-a-pnpm-launcher',
    );
    const result = spawnSync(process.execPath, [entryPoint], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'fixed-node-entry-ok');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('published runtime still rejects dependency directory links outside pnpm launchers', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'auto-agent-runtime-links-'));
  try {
    const runtime = join(temporary, 'runtime');
    const external = join(temporary, 'external');
    await mkdir(join(runtime, 'node_modules'), { recursive: true });
    await mkdir(external);
    await writeFile(join(external, 'keep.txt'), 'external-data');
    await symlink(external, join(runtime, 'node_modules/linked-package'), 'junction');
    await assert.rejects(preparePublishedTree(runtime), /Runtime must not contain links:/);
    assert.equal(await readFile(join(external, 'keep.txt'), 'utf8'), 'external-data');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
