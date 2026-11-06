import { test } from 'node:test';
import { expect } from 'expect';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/sqlite';
import { builtinParsers, ParserRegistry, WikiLibrary } from '../src';

test('published references coexist with configured sources through one search and read protocol', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wiki-bundle-'));
  const registry = () => new ParserRegistry(builtinParsers);
  let library: WikiLibrary | undefined;
  try {
    const raw = join(root, 'raw');
    await mkdir(raw);
    await writeFile(join(raw, 'built-in.md'), '共享资料 内置来源');
    const publisher = new WikiLibrary(join(root, 'publisher', 'wiki.sqlite'), registry());
    const bundle = join(root, 'reference.sqlite');
    try {
      await publisher.build(
        [{ id: 'reference', type: 'directory', path: raw }],
        new AbortController().signal,
      );
      publisher.exportBundle(bundle);
    } finally {
      await publisher.close();
    }
    const snapshot = new Database(bundle, { readonly: true });
    try {
      expect(JSON.stringify(snapshot.query('SELECT config FROM sources').all())).not.toContain(
        root,
      );
    } finally {
      snapshot.close();
    }
    library = new WikiLibrary(join(root, 'user', 'wiki.sqlite'), registry(), [
      { id: 'published', path: bundle },
    ]);
    expect(library.search({ query: '共享资料' }).results).toHaveLength(1);
    const extra = join(root, 'external');
    await mkdir(extra);
    await writeFile(join(extra, 'user.txt'), '共享资料 用户来源');
    await library.build(
      [{ id: 'user', type: 'directory', path: extra }],
      new AbortController().signal,
    );
    expect(library.search({ query: '共享资料' }).results).toHaveLength(2);
    await library.build([], new AbortController().signal);
    expect(library.search({ query: '共享资料' }).results).toHaveLength(1);
    const reference = library.search({ query: '内置来源' }).results[0]!.reference;
    expect(library.read({ reference }).units[0]!.text).toContain('内置来源');
    await library.close();
    library = new WikiLibrary(join(root, 'user', 'wiki.sqlite'), registry());
    expect(library.search({ query: '共享资料' }).results).toHaveLength(0);
  } finally {
    await library?.close();
    await rm(root, { recursive: true, force: true });
  }
});
