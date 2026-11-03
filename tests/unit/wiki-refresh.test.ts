import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fixture } from '../helpers';
import { Wiki } from '../../src/wiki';
import { loadBundledSnapshot, snapshotPath } from '../../src/wiki/snapshot';

test('reusing changed bundled knowledge publishes a fresh snapshot even with zero model extractions', async () => {
  const f = await fixture();
  const config = { ...f.config, builtinWiki: true, resourceLimitBytes: 65536 };
  const wiki = new Wiki(config);
  try {
    const bundled = (await loadBundledSnapshot(config))!;
    const old = structuredClone(bundled);
    old.sources[0]!.hash = '0'.repeat(64);
    old.builtAt = 1;
    const path = snapshotPath(config);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(old));
    expect((await wiki.status()).state).toBe('stale');
    const model = {
      async generate() {
        throw new Error('Unexpected main call');
      },
      async generateKnowledge() {
        throw new Error('Unexpected extraction');
      },
    };
    const updated = await wiki.update(model, new AbortController().signal);
    expect(updated.rebuilt).toBe(0);
    expect(updated.builtAt).not.toBe(1);
    expect((await wiki.status()).state).toBe('ready');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.sources).toEqual(bundled.sources);
    expect((await wiki.update(model, new AbortController().signal)).builtAt).toBe(updated.builtAt);
  } finally {
    wiki.close();
    await f.cleanup();
  }
});
