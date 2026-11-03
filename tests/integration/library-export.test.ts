import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fixture } from '../helpers';
import { referenceSamFixture } from '../case-helpers';
import { SourceIndex } from '../../src/wiki/file-index';

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
        resolve('scripts/export-library.ts'),
        '--root',
        root,
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
      records: 1,
      scanned: 2,
      pretreatmentFiles: 1,
      pretreatmentEntries: 2,
      preservedLabTypes: 1,
      reports: 3,
      integrity: 'ok',
      fullReadsOverBudget: 0,
    });
    const before = await readFile(output);
    const exists = await run();
    expect(exists.code).not.toBe(0);
    expect(await readFile(output)).toEqual(before);
    await writeFile(join(root, 'broken.SAM'), Buffer.from([0, 0, 16, 16, 0, 0, 0, 2, 0, 123]));
    const failed = await run(true);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('previous snapshot retained');
    expect(await readFile(output)).toEqual(before);
    expect(await readFile(join(root, 'case.SAM'))).toEqual(source);
    const db = new Database(output, { readonly: true });
    try {
      const index = new SourceIndex(
        { dataDir: f.dir, wikiIndexRoots: [], resourceLimitBytes: 65536 },
        db,
        true,
      );
      const found = index.search({ filters: { hasPretreatment: true, labType: 1 } });
      expect(found.results).toHaveLength(1);
      const read = await index.read({ id: found.results[0].id, sections: ['sample', 'reports'] });
      expect(read.sourceVerified).toBe(false);
      expect((read.record.configuration!.file as any).path).toBe('case.SAM');
      expect(JSON.stringify(read.record.configuration)).not.toContain(f.dir);
      expect(JSON.stringify(read.record.configuration)).toContain('REFERENCE_PRETREATMENT');
    } finally {
      db.close();
    }
  } finally {
    await f.cleanup();
  }
}, 30000);
