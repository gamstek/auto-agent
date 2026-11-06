import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ownCoraxRuntime, prepareCoraxData } from '../../lib/config';

test('one backend owns the configured Corax runtime directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'corax-runtime-owner-'));
  try {
    const directory = prepareCoraxData(root);
    expect(directory).toBe(join(root, 'corax'));
    const release = ownCoraxRuntime(directory);
    try {
      expect(() => ownCoraxRuntime(directory)).toThrow('Another backend');
    } finally {
      release();
    }
    ownCoraxRuntime(directory)();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
