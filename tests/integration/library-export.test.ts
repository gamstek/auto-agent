import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from '../helpers';
import { referenceSamFixture } from '../case-helpers';
import { WikiLibrary, ParserRegistry, builtinParsers } from '@auto-agent/wiki-core';
import { samParser } from '@auto-agent/wiki-sam';

test('offline library export publishes portable core references and retains the previous snapshot on extraction errors', async () => {
  const f = await fixture();
  const root = join(f.dir, 'cases'),
    output = join(f.dir, 'library.sqlite');
  await mkdir(root);
  const source = referenceSamFixture();
  await writeFile(join(root, 'case.SAM'), source);
  await writeFile(join(root, 'other.SMP'), '^vMIC unsupported');
  const run = async (replace = false) => {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve('scripts/publish-wiki.ts'),
        '--source',
        `cases=${root}`,
        '--include',
        '**/*.SAM',
        '--output',
        output,
        ...(replace ? ['--replace'] : []),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const timer = setTimeout(() => child.kill(), 20000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const exported = await run();
    expect(exported.code, exported.stderr).toBe(0);
    expect(JSON.parse(exported.stdout)).toMatchObject({
      documents: 1,
      parsed: 1,
      verified: true,
    });
    const before = await readFile(output);
    const exists = await run();
    expect(exists.code).not.toBe(0);
    expect(await readFile(output)).toEqual(before);
    await writeFile(join(root, 'broken.SAM'), Buffer.from([0, 0, 16, 16, 0, 0, 0, 2, 0, 123]));
    const failed = await run(true);
    expect(failed.code).not.toBe(0);
    expect(await readFile(output)).toEqual(before);
    expect(await readFile(join(root, 'case.SAM'))).toEqual(source);
    const db = new Database(output, { readonly: true });
    try {
      expect(JSON.stringify(db.query('SELECT config FROM sources').all())).not.toContain(f.dir);
    } finally {
      db.close();
    }
    const library = new WikiLibrary(join(f.dir, 'consumer', 'wiki.sqlite'), new ParserRegistry([...builtinParsers, samParser]), [{ id: 'published', path: output }]);
    try {
      const found = library.search({ query: 'REFERENCE_PRETREATMENT', filters: [{ field: 'sam.labType', op: 'eq', value: 1 }] });
      expect(found.results).toHaveLength(1);
      const read = library.read({ reference: found.results[0]!.reference });
      expect(read.sourceVerified).toBe(false);
      expect(JSON.stringify(read)).not.toContain(f.dir);
      expect(JSON.stringify(read)).toContain('REFERENCE_PRETREATMENT');
    } finally { await library.close(); }
  } finally {
    await f.cleanup();
  }
}, 30000);
