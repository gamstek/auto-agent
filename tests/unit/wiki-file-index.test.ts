import { expect, test, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { SourceIndex } from '../../src/wiki/file-index';
import { Wiki } from '../../src/wiki';
import { samFixture } from '../case-helpers';

async function setup() {
  const f = await fixture();
  const root = join(f.dir, 'templates');
  await mkdir(join(root, '石墨'), { recursive: true });
  const config = { ...f.config, wikiIndexRoots: [root], resourceLimitBytes: 65536 };
  const store = new Store(config.dataDir),
    index = new SourceIndex(config, store.db);
  await writeFile(join(root, '石墨', 'first.SAM'), samFixture());
  await writeFile(join(root, '石墨', 'copy.SAM'), samFixture());
  await writeFile(join(root, '石墨', 'foreign.SMP'), '^vMIC##&&FS-other-format');
  await writeFile(join(root, '石墨', 'other.SAM'), samFixture('g12', 'CO2'));
  await writeFile(join(root, '石墨', 'report.pdf'), '%PDF-1.4 must not be parsed');
  await writeFile(join(root, '石墨', '说明.md'), 'not part of template reference indexing');
  return {
    ...f,
    root,
    config,
    store,
    index,
    dispose: async () => {
      store.close();
      await f.cleanup();
    },
  };
}
test('template indexing skips reports, reuses unchanged templates and enforces structured filters', async () => {
  const f = await setup();
  try {
    expect(f.index.status().state).toBe('unbuilt');
    expect(() => f.index.search({ query: '石墨' })).toThrow('explicitly');
    expect(await f.index.update(new AbortController().signal)).toMatchObject({
      records: 4,
      reused: 0,
      rebuilt: 4,
      errors: 0,
    });
    expect(f.index.status()).toMatchObject({ state: 'ready', parsed: 3, unsupported: 1 });
    expect(await f.index.update(new AbortController().signal)).toMatchObject({
      reused: 4,
      rebuilt: 0,
    });
    const result = f.index.search({
      query: '石墨 BET',
      filters: { product: 'g5', gas: 'N2', temperatureMinK: 77, temperatureMaxK: 78 },
    });
    expect(result.matchedRecords).toBe(1);
    expect(result.results[0].metadata).toMatchObject({
      materialBasis: 'directory-hint',
      productBasis: 'status-family',
      fileState: 'completed',
    });
    expect(f.index.search({ query: 'must not be parsed' }).results).toEqual([]);
    expect(f.index.search({ filters: { gas: 'Ar' } }).results).toEqual([]);
    expect(() => f.index.search({ filters: { kind: 'pdf' } })).toThrow('Invalid');
    expect(() =>
      f.index.search({ filters: { temperatureMinK: 100, temperatureMaxK: 50 } }),
    ).toThrow('Invalid');
  } finally {
    await f.dispose();
  }
});

test('confinement compares canonical roots when filesystem aliases expand configured paths', async () => {
  const f = await setup();
  const original = fs.realpath;
  const alias = (async (...args: Parameters<typeof original>) => {
    const value = await original(...args);
    const mapped = join(f.dir, 'canonical-view', value.toString());
    return typeof value === 'string' ? mapped : Buffer.from(mapped);
  }) as typeof original;
  const canonical = spyOn(fs, 'realpath').mockImplementation(alias);
  try {
    expect(await f.index.update(new AbortController().signal)).toMatchObject({
      records: 4,
      errors: 0,
    });
    const result = f.index.search({ filters: { product: 'g5' } }).results[0];
    expect((await f.index.read({ id: result.id })).sourceVerified).toBe(true);
    expect(canonical).toHaveBeenCalled();
  } finally {
    canonical.mockRestore();
    await f.dispose();
  }
});
test('template read verifies original hashes and retains JSON field evidence', async () => {
  const f = await setup();
  try {
    await f.index.update(new AbortController().signal);
    const result = f.index.search({ filters: { product: 'g5' } }).results[0];
    const read = await f.index.read({ id: result.id });
    expect(read.sourceVerified).toBe(true);
    expect(read.record.configuration?.executionVerified).toBe(false);
    expect(read.record.evidence[0].kind).toBe('json-path');
    await writeFile(join(f.root, result.path), samFixture('g5', 'He'));
    await expect(f.index.read({ id: result.id })).rejects.toMatchObject({
      code: 'wiki_index_stale',
    });
    expect((await f.index.update(new AbortController().signal)).rebuilt).toBe(1);
    await rm(join(f.root, '石墨', 'foreign.SMP'));
    expect((await f.index.update(new AbortController().signal)).records).toBe(3);
  } finally {
    await f.dispose();
  }
});
test('cancellation and root confinement retain the previous template index', async () => {
  const f = await setup();
  try {
    await f.index.update(new AbortController().signal);
    const before = f.index.status().indexedAt;
    const abort = new AbortController();
    abort.abort();
    await expect(f.index.update(abort.signal)).rejects.toThrow();
    const missing = new SourceIndex(
      { ...f.config, wikiIndexRoots: [join(f.dir, 'missing')] },
      f.store.db,
    );
    await expect(missing.update(new AbortController().signal)).rejects.toMatchObject({
      code: 'wiki_index_roots',
    });
    expect(f.index.status().indexedAt).toBe(before);
    const outside = join(f.dir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.SAM'), samFixture());
    await symlink(outside, join(f.root, 'linked'), 'junction');
    expect((await f.index.update(new AbortController().signal)).skippedLinks).toBe(1);
    expect(await readFile(join(f.root, '石墨', 'first.SAM'))).toEqual(samFixture());
  } finally {
    await f.dispose();
  }
});
test('template output budgets never silently clip configuration', async () => {
  const f = await setup();
  try {
    await f.index.update(new AbortController().signal);
    const id = f.index.search({ filters: { product: 'g5' } }).results[0].id;
    const bounded = new SourceIndex({ ...f.config, resourceLimitBytes: 1300 }, f.store.db);
    expect(Buffer.byteLength(JSON.stringify(bounded.search({ limit: 10 })))).toBeLessThanOrEqual(
      1300,
    );
    await expect(bounded.read({ id })).rejects.toMatchObject({ code: 'wiki_index_output_limit' });
  } finally {
    await f.dispose();
  }
});
test('bundled SQLite templates work without originals and remain explicitly unverified historical references', async () => {
  const f = await setup();
  const wiki = new Wiki({ ...f.config, builtinWiki: true, wikiIndexRoots: [] }, f.store.db);
  try {
    expect(wiki.indexStatus()).toMatchObject({
      state: 'ready',
      records: 178,
      mode: 'readonly-snapshot',
    });
    const result = wiki.search({ filters: { product: 'g5', gas: 'N2' } });
    expect(result.results.length).toBeGreaterThan(0);
    const source = await wiki.read({ id: result.results[0].id });
    expect(source.sourceVerified).toBe(false);
    expect(source.record.origin).toMatchObject({ kind: 'sam', sourceVerified: false });
    expect(source.record.configuration?.executionVerified).toBe(false);
    expect(JSON.stringify(source.record.configuration)).not.toContain('C:/Users/');
    expect(await wiki.indexSources(new AbortController().signal)).toMatchObject({
      records: 178,
      reused: 178,
      rebuilt: 0,
    });
  } finally {
    wiki.close();
    await f.dispose();
  }
});
