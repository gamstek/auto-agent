import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetInstalledData } from '../../desktop/src-tauri/installer/reset-data';
import { DATA_LAYOUT } from '../../lib/config/paths';

test('installer resets an incompatible isolated layout once and preserves compatible reinstalls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent-install-'));
  const data = join(root, '.auto-agent');
  try {
    await mkdir(data);
    await writeFile(join(data, 'config.json'), '{"contextWindow":32000}');
    await writeFile(join(data, '.data-layout'), 'old-layout');
    assert.equal(await resetInstalledData(data), 'initialized');
    await assert.rejects(readFile(join(data, 'config.json')));
    assert.equal(await readFile(join(data, '.data-layout'), 'utf8'), DATA_LAYOUT);
    await writeFile(join(data, 'current-conversations'), 'keep');
    assert.equal(await resetInstalledData(data), 'preserved');
    assert.equal(await readFile(join(data, 'current-conversations'), 'utf8'), 'keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installer never follows a root link or nested directory junction to external files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent-install-links-'));
  const outside = join(root, 'outside');
  const data = join(root, '.auto-agent');
  try {
    await mkdir(outside);
    await writeFile(join(outside, 'original.txt'), 'preserve original');
    await symlink(outside, data, 'junction');
    await assert.rejects(resetInstalledData(data), /regular directory/);
    await rm(data);
    await mkdir(data);
    await symlink(outside, join(data, 'originals'), 'junction');
    await resetInstalledData(data);
    assert.equal(await readFile(join(outside, 'original.txt'), 'utf8'), 'preserve original');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
