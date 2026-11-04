import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import {
  builtinParsers,
  ParserRegistry,
  WikiLibrary,
  WikiError,
  type DocumentParser,
} from '../src';

async function fixture(parsers: readonly DocumentParser[] = builtinParsers) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-core-'));
  const sources = join(root, 'sources');
  await mkdir(sources);
  const database = join(root, 'state', 'wiki.sqlite');
  const library = new WikiLibrary(database, new ParserRegistry(parsers));
  const input = [{ id: 'docs', type: 'directory' as const, path: sources }];
  return {
    root,
    sources,
    database,
    library,
    input,
    signal: new AbortController().signal,
    async close() {
      await library.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('mixed documents search locally with versioned citations and unsupported inventory', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sources, 'manual.md'), '# 操作手册\n石墨 比表面积 测试说明\n原文证据');
    await writeFile(
      join(f.sources, 'values.json'),
      JSON.stringify({ 'a/b': { '~key': '石墨配置' } }),
    );
    await writeFile(join(f.sources, 'report.pdf'), 'unsupported bytes');
    const result = await f.library.build(f.input, f.signal);
    expect(result).toMatchObject({ documents: 3, parsed: 2, unsupported: 1, rebuilt: 2 });
    const hits = f.library.search({ query: '石墨', limit: 10 });
    expect(hits.results).toHaveLength(2);
    const md = hits.results.find((hit) => hit.mediaType === 'text/markdown')!;
    const read = f.library.read({ reference: md.reference });
    expect(read.units[0]!.locator).toEqual({ kind: 'lines', start: 1, end: 3 });
    expect(read.units[0]!.text).toContain('原文证据');
    expect(read.sourceVerified).toBe(false);
    expect((await f.library.build(f.input, f.signal)).reused).toBe(2);
    expect(f.library.documents().find((doc) => (doc as any).path === 'report.pdf')).toMatchObject({
      state: 'unsupported',
      code: 'unsupported_format',
    });
  } finally {
    await f.close();
  }
});

test('updates retain old cited versions, remove deleted documents, and reject stale cursors', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sources, 'a.md'), 'shared original');
    await writeFile(join(f.sources, 'b.txt'), 'shared second');
    await f.library.build(f.input, f.signal);
    const page = f.library.search({ query: 'shared', limit: 1 });
    expect(page.nextCursor).not.toBeNull();
    expect(
      f.library.search({ query: 'shared', limit: 1, cursor: page.nextCursor! }).results,
    ).toHaveLength(1);
    const original = f.library.search({ query: 'original' }).results[0]!.reference;
    await writeFile(join(f.sources, 'a.md'), 'shared replacement');
    await unlink(join(f.sources, 'b.txt'));
    expect((await f.library.build(f.input, f.signal)).removed).toBe(1);
    expect(f.library.search({ query: 'original' }).results).toEqual([]);
    expect(f.library.read({ reference: original }).units[0]!.text).toBe('shared original');
    expect(() => f.library.search({ query: 'shared', limit: 1, cursor: page.nextCursor! })).toThrow(
      'restart the search',
    );
    await f.library.build([], f.signal);
    expect(() => f.library.read({ reference: original })).toThrow('outside active sources');
  } finally {
    await f.close();
  }
});

test('failed or cancelled builds keep the last published generation intact', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sources, 'good.md'), 'preserved');
    const first = await f.library.build(f.input, f.signal);
    await writeFile(join(f.sources, 'broken.json'), '{');
    await expect(f.library.build(f.input, f.signal)).rejects.toMatchObject({ code: 'source_json' });
    expect(f.library.catalog().generation).toBe(first.generation);
    expect(f.library.search({ query: 'preserved' }).results).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(f.library.build(f.input, controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    await expect(
      f.library.build([{ ...f.input[0]!, path: join(f.root, 'missing') }], f.signal),
    ).rejects.toThrow('previous index retained');
    expect(f.library.catalog().generation).toBe(first.generation);
  } finally {
    await f.close();
  }
});

test('parser version invalidates cached content and plugin fields use validated generic filters', async () => {
  const parser: DocumentParser = {
    id: 'fixture.custom',
    version: '1',
    fields: [{ name: 'fixture.score', type: 'number' }],
    supports: (path) => path.endsWith('.custom'),
    async parse() {
      return {
        title: 'Fixture',
        mediaType: 'text/plain',
        attributes: { 'fixture.score': 4 },
        issues: [],
        units: [{ text: 'custom content', locator: { kind: 'section', name: 'main' } }],
      };
    },
  };
  const f = await fixture([parser]);
  try {
    await writeFile(join(f.sources, 'data.custom'), 'source');
    await f.library.build(f.input, f.signal);
    const original = f.library.search({
      query: 'custom',
      filters: [{ field: 'fixture.score', op: 'gte', value: 3 }],
    }).results[0]!.reference;
    expect(() => f.library.search({ filters: [{ field: 'unknown', op: 'eq', value: 1 }] })).toThrow(
      'Unknown field',
    );
    parser.version = '2';
    expect((await f.library.build(f.input, f.signal)).rebuilt).toBe(1);
    const next = f.library.search({ query: 'custom' }).results[0]!.reference;
    expect(next.versionId).toBe(original.versionId);
    expect(next.representationId).not.toBe(original.representationId);
    expect(f.library.read({ reference: original }).parserVersion).toBe('1');
  } finally {
    await f.close();
  }
});

test('ownership, concurrent builds and close cancellation are deterministic', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const parser: DocumentParser = {
    id: 'fixture.slow',
    version: '1',
    fields: [],
    supports: () => true,
    async parse(_source, { signal }) {
      entered();
      await new Promise<never>((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      throw new Error('unreachable');
    },
  };
  const f = await fixture([parser]);
  try {
    expect(() => new WikiLibrary(f.database, new ParserRegistry([]))).toThrow('owns');
    await writeFile(join(f.sources, 'input.txt'), 'source');
    const pending = f.library.build(f.input, f.signal);
    void pending.catch(() => {});
    await ready;
    expect(() => f.library.build(f.input, f.signal)).toThrow('already running');
    await f.library.close();
    await expect(pending).rejects.toBeInstanceOf(WikiError);
    const reopened = new WikiLibrary(f.database, new ParserRegistry(builtinParsers));
    try {
      expect(reopened.catalog().generation).toBeUndefined();
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

test('read budgets never silently clip a unit and identifiers cannot cross documents', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.sources, 'one.md'), 'long content '.repeat(500));
    await writeFile(join(f.sources, 'two.md'), 'small');
    await f.library.build(f.input, f.signal);
    const one = f.library.search({ query: 'long' }).results[0]!.reference;
    const two = f.library.search({ query: 'small' }).results[0]!.reference;
    expect(() => f.library.read({ reference: one, maxBytes: 512 })).toThrow('complete unit');
    expect(() => f.library.read({ reference: { ...one, documentId: two.documentId } })).toThrow(
      'unavailable',
    );
    expect(f.library.read({ reference: one, maxBytes: 16384 }).units[0]!.text.length).toBe(6500);
  } finally {
    await f.close();
  }
});

test('missing derived units invalidate a content-hash cache hit and are repaired atomically', async () => {
  const f = await fixture();
  let reopened: WikiLibrary | undefined;
  try {
    await writeFile(join(f.sources, 'a.md'), 'source content');
    await f.library.build(f.input, f.signal);
    const reference = f.library.search({ query: 'source' }).results[0]!.reference;
    await f.library.close();
    const damaged = new Database(f.database);
    try {
      damaged.exec('DELETE FROM units; DELETE FROM wiki_fts;');
    } finally {
      damaged.close();
    }
    reopened = new WikiLibrary(f.database, new ParserRegistry(builtinParsers));
    expect(reopened.lint()).toMatchObject({
      healthy: false,
      issues: [{ code: 'derived_content_incomplete' }],
    });
    expect((await reopened.build(f.input, f.signal)).rebuilt).toBe(1);
    expect(reopened.lint().healthy).toBe(true);
    expect(reopened.read({ reference }).units[0]!.text).toBe('source content');
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('search ranks one best unit per document rather than filling the page with one source', async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.sources, 'many.md'),
      Array.from({ length: 240 }, () => 'shared topic repeated').join('\n'),
    );
    await writeFile(join(f.sources, 'other.md'), 'shared topic');
    await f.library.build(f.input, f.signal);
    const results = f.library.search({ query: 'shared', limit: 2 }).results;
    expect(results).toHaveLength(2);
    expect(new Set(results.map((entry) => entry.reference.documentId)).size).toBe(2);
  } finally {
    await f.close();
  }
});

test('publication storage failure rolls back documents, search and generation together', async () => {
  const f = await fixture();
  let reopened: WikiLibrary | undefined;
  try {
    await writeFile(join(f.sources, 'a.md'), 'original');
    const first = await f.library.build(f.input, f.signal);
    await f.library.close();
    const fault = new Database(f.database);
    try {
      fault.exec(
        "CREATE TRIGGER reject_publish BEFORE UPDATE ON wiki_meta BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;",
      );
    } finally {
      fault.close();
    }
    await writeFile(join(f.sources, 'a.md'), 'replacement');
    reopened = new WikiLibrary(f.database, new ParserRegistry(builtinParsers));
    await expect(reopened.build(f.input, f.signal)).rejects.toThrow('previous index retained');
    expect(reopened.catalog().generation).toBe(first.generation);
    expect(reopened.search({ query: 'original' }).results).toHaveLength(1);
    expect(reopened.search({ query: 'replacement' }).results).toHaveLength(0);
    expect(reopened.lint().healthy).toBe(true);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('source links are rejected and core does not import application or domain implementations', async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.txt'), 'outside data');
    await symlink(outside, join(f.sources, 'linked'), 'junction');
    await expect(f.library.build(f.input, f.signal)).rejects.toMatchObject({ code: 'source_path' });
    expect(f.library.catalog().generation).toBeUndefined();
    for await (const path of new Bun.Glob('**/*.ts').scan({
      cwd: join(import.meta.dir, '../src'),
      absolute: true,
    })) {
      expect(await Bun.file(path).text()).not.toMatch(
        /@auto-agent\/(?:wiki-sam|climber-mcp)|\blabType\b|\bg5\b|\.\.\/.*src\/(?:agent|storage|skill)/,
      );
    }
  } finally {
    await f.close();
  }
});
