import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  removeLegacyResources,
  resetInstalledData,
} from '../../desktop/src-tauri/installer/reset-data';
import { DATA_LAYOUT } from 'auto-agent/config/paths';

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

test('runtime replacement removes legacy payloads without following links or deleting user data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auto-agent-install-resources-'));
  const installation = join(root, 'application');
  const outside = join(root, 'outside');
  try {
    await mkdir(installation);
    await mkdir(outside);
    await writeFile(join(outside, 'bun.exe'), 'external original');
    await symlink(outside, join(installation, 'backend'), 'junction');
    await writeFile(join(installation, 'auto-agent-backend.exe'), 'obsolete');
    await mkdir(join(installation, 'runtime'));
    await writeFile(join(installation, 'runtime/node.exe'), 'current');
    await writeFile(join(installation, 'config.json'), 'preserve');
    await removeLegacyResources(installation);
    await assert.rejects(readFile(join(installation, 'backend/bun.exe')));
    await assert.rejects(readFile(join(installation, 'auto-agent-backend.exe')));
    assert.equal(await readFile(join(outside, 'bun.exe'), 'utf8'), 'external original');
    assert.equal(await readFile(join(installation, 'runtime/node.exe'), 'utf8'), 'current');
    assert.equal(await readFile(join(installation, 'config.json'), 'utf8'), 'preserve');
    await mkdir(join(installation, 'backend'));
    await writeFile(join(installation, 'backend/bun.exe'), 'obsolete');
    await removeLegacyResources(installation);
    await removeLegacyResources(installation);
    await symlink(outside, join(root, 'linked-installation'), 'junction');
    await assert.rejects(
      removeLegacyResources(join(root, 'linked-installation')),
      /regular directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
