import { expect, test } from 'bun:test';
import { ParserRegistry } from '@auto-agent/wiki-core/contracts';
import { createHash } from 'node:crypto';
import { samParser } from '../src';

test('SAM parser preserves historical mode, units and field source without a host store', async () => {
  const root = {
    clientVersion: '2.11.1',
    labType: 1,
    'analysis conditions': {
      'analysis type': 0,
      'adsorptive properties': { mnemonic: 'N2' },
      'p0 and temperature options': { temperature: -195.85 },
      'isotherm collection': {
        'use target pressure': true,
        pressures: [{ start_p: 0.05, end_p: 0.3 }],
        options: {},
      },
    },
  };
  const body = Buffer.from(JSON.stringify(root), 'utf16le').swap16();
  const header = Buffer.alloc(8);
  header.writeInt32BE(0x1040, 0);
  header.writeUInt32BE(body.length, 4);
  const bytes = Buffer.concat([header, body]);
  const parsed = await samParser.parse(
    { path: 'sample.SAM', bytes, sha256: createHash('sha256').update(bytes).digest('hex') },
    { signal: new AbortController().signal },
  );
  new ParserRegistry([samParser]).validate(samParser, parsed);
  expect(parsed.attributes).toMatchObject({
    'sam.product': 'g5',
    'sam.labType': 1,
    'sam.gas': 'N2',
  });
  expect(
    parsed.units.some(
      (unit) => unit.locator.kind === 'json-pointer' && unit.locator.pointer === '/labType',
    ),
  ).toBe(true);
  expect(JSON.stringify(parsed.units)).toContain('unit');
});

test('foreign SMP format reports unsupported rather than treating bytes as text', async () => {
  const bytes = Buffer.from('^vMIC arbitrary foreign format');
  await expect(
    samParser.parse(
      { path: 'foreign.SMP', bytes, sha256: '' },
      { signal: new AbortController().signal },
    ),
  ).rejects.toMatchObject({ code: 'unsupported_format' });
});
