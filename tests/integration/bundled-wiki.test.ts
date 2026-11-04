import { expect, test } from 'bun:test';
import { fixture } from '../helpers';
import { createWikiLibrary } from '../../src/integrations/wiki-library';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('published documents and templates are ready without source scans or model requests', async () => {
  const f = await fixture();
  f.config.builtinWiki = true;
  const library = createWikiLibrary(f.config);
  try {
    const catalog = library.catalog();
    expect(catalog.sources.reduce((sum, source) => sum + source.parsed, 0)).toBe(179);
    const found = library.search({ query: '石墨', limit: 50 });
    expect(new Set(found.results.map((result) => result.mediaType))).toEqual(new Set(['text/markdown', 'application/x-sam']));
    for (const result of found.results) expect(library.read({ reference: result.reference }).units.length).toBeGreaterThan(0);
    const source = join(f.dir, 'external'); await mkdir(source); await writeFile(join(source, 'guide.md'), '新的统一资料 ExternalReference');
    await library.build([{ id: 'external', type: 'directory', path: source }], new AbortController().signal);
    expect(library.search({ query: 'ExternalReference' }).results).toHaveLength(1);
    expect(library.search({ query: '石墨', limit: 50 }).results.length).toBeGreaterThan(1);
  } finally { await library.close(); await f.cleanup(); }
});
