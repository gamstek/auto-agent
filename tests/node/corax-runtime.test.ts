import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyCoraxRuntime } from '../../desktop/scripts/corax-runtime';

test('installed registry package includes the SQLite World and finite-history implementation', async () => {
  await verifyCoraxRuntime(resolve(import.meta.dirname, '../..'));
});

test('deployment rejects stale or incorrectly sourced Corax packages', async () => {
  const runtime = await mkdtemp(join(tmpdir(), 'corax-runtime-check-'));
  const root = join(runtime, 'node_modules/@coraxjs/core');
  try {
    await mkdir(join(root, 'dist/src/compiled/@workflow/world-local'), { recursive: true });
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: '@coraxjs/core', version: '0.1.0' }),
    );
    await assert.rejects(verifyCoraxRuntime(runtime), /published @coraxjs\/core@0\.1\.1/);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: '@coraxjs/core', version: '0.1.1' }),
    );
    await writeFile(
      join(root, 'dist/src/compiled/@workflow/world-local/UPSTREAM.json'),
      JSON.stringify({ repository: 'vercel/workflow', commit: 'unexpected' }),
    );
    await assert.rejects(verifyCoraxRuntime(runtime), /verified official SQLite/);
  } finally {
    await rm(runtime, { recursive: true, force: true });
  }
});
