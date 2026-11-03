import { expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeSam, summarizeSam } from '../../src/wiki/file-index/sam';
import { extract } from '../../src/wiki/file-index/extract';
import { samFixture, referenceSamFixture } from '../case-helpers';

function encode(root: unknown, status = 0x1010) {
  const body = Buffer.from(JSON.stringify(root), 'utf16le').swap16();
  const header = Buffer.alloc(8);
  header.writeInt32BE(status);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
test('Wiki decodes one byte snapshot, including nonzero view offsets, without a source file', async () => {
  const bytes = referenceSamFixture();
  const wrapped = Buffer.concat([Buffer.alloc(17), bytes, Buffer.alloc(5)]);
  const view = wrapped.subarray(17, 17 + bytes.length);
  const decoded = decodeSam(view);
  const summary = summarizeSam(decoded, view, 'missing/example.SAM');
  expect(summary.file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(summary.facts.labType!.value).toBe(1);
  expect(summary.facts.temperatureK!.value as number).toBeCloseTo(77.3);
  expect(summary.pressureProgram.segments![0]).toMatchObject({
    start: 0.05,
    end: 0.3,
    step: 0.025,
    intervalSeconds: 5,
  });
  const record: any = {
    path: 'missing/example.SAM',
    sha256: summary.file.sha256,
    metadata: {},
    evidence: [],
    issues: [],
  };
  expect((await extract(record, view, new AbortController().signal)).state).toBe('parsed');
  await expect(
    extract({ ...record, sha256: '0'.repeat(64) }, view, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'wiki_index_changed' });
  const abort = new AbortController();
  abort.abort();
  await expect(extract(record, view, abort.signal)).rejects.toThrow();
});
test('Wiki format decoder rejects malformed framing/encoding/JSON and unsupported source formats', () => {
  const valid = samFixture();
  const invalidLength = Buffer.from(valid);
  invalidLength.writeUInt32BE(1, 4);
  const nullString = Buffer.from(valid);
  nullString.writeUInt32BE(0xffffffff, 4);
  const invalidUtf16 = Buffer.from([0, 0, 16, 16, 0, 0, 0, 2, 0xd8, 0]);
  for (const [bytes, code] of [
    [Buffer.from('^vMIC anything'), 'UNSUPPORTED_FORMAT'],
    [Buffer.from('{}'), 'INVALID_HEADER'],
    [invalidLength, 'INVALID_HEADER'],
    [nullString, 'EMPTY_TEMPLATE'],
    [invalidUtf16, 'INVALID_ENCODING'],
    [encode([]), 'INVALID_JSON'],
    [encode({}), 'NOT_SAMPLE_TEMPLATE'],
  ] as const) {
    try {
      decodeSam(bytes);
      throw new Error('Accepted invalid template');
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  }
  const nonfinite = encode({ value: 'REPLACE' });
  const body = Buffer.from('{"value":1e999}', 'utf16le').swap16();
  const header = nonfinite.subarray(0, 8);
  header.writeUInt32BE(body.length, 4);
  expect(() => decodeSam(Buffer.concat([header, body]))).toThrow('nonfinite');
});
test('Wiki preserves product-specific enums, ordered programs, raw values and known unit conversions', () => {
  for (const product of ['g5', 'g12']) {
    const root = decodeSam(samFixture(product)).root;
    root['analysis conditions']['analysis type'] = product === 'g5' ? 5 : 10;
    root['analysis conditions']['free space options']['free space option type'] = 1;
    const collection = root['analysis conditions']['isotherm collection'];
    collection['absolute pressure dosing'] = true;
    collection['use target pressure'] = false;
    collection.pressures = [{ start_p: 0.76, end_p: 0.1, increment_p: 0, interval: 30 }];
    collection.increments = [
      {
        end_p: 0.76,
        'dose increment': 2,
        'percent of previous': 10,
        interval: 6,
        'use dose increment': false,
      },
    ];
    collection.options = { D_LPressIncrementalDoseMode: true, D_MinEquilibrationDelay: 0.5 };
    const bytes = encode(root, product === 'g5' ? 0x1040 : 0x2040);
    const result = summarizeSam(decodeSam(bytes), bytes, 'case.SAM');
    expect(result.facts.analysisType!.value).toBe('micropore');
    expect(result.facts.freeSpaceMode!.value).toBe(
      product === 'g5' ? 'manual' : 'post-calibration',
    );
    expect(result.pressureProgram).toMatchObject({ active: false, unit: 'mmHg' });
    expect(result.pressureProgram.segments![0]).toMatchObject({
      start: 760,
      end: 100,
      step: 0,
      direction: 'descending',
      endpointOnly: true,
      raw: { start_p: 0.76 },
    });
    expect(result.incrementProgram.segments![0]).toMatchObject({
      end: 760,
      useDoseIncrement: false,
    });
    expect(result.facts.lowPressureMinHours).toMatchObject({ value: 0.5, unit: 'h' });
    collection.pressures = Array.from({ length: 257 }, () => ({}));
    const oversized = encode(root);
    expect(() => summarizeSam(decodeSam(oversized), oversized, 'case.SAM')).toThrow('256');
  }
});
test('host source has no imports or requires into portable skill implementation files', async () => {
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const text = await readFile(path, 'utf8');
        expect(text, path).not.toMatch(
          /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"][^'"]*skills\//,
        );
      }
    }
  }
  await scan(resolve('src'));
});
