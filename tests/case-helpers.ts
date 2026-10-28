export function samFixture(product = 'g5', gas = 'N2') {
  const value = {
    'sample name': 'Synthetic graphite',
    uuid: '12345678-1234-4234-8234-123456789abc',
    softwareVersion: 'fixture',
    clientVersion: 'fixture-v1',
    analysisStatus: product === 'g5' ? 0x1040 : 0x2040,
    mass: { 'sample mass': 1.5, 'tube mass': 29.1 },
    unit: 1,
    port: 0,
    'analysis conditions': {
      'analysis type': 0,
      'adsorptive properties': { mnemonic: gas },
      'p0 and temperature options': { temperature: gas === 'N2' ? -195.85 : 0 },
      'free space options': { 'free space option type': 0 },
      'isotherm collection': {
        'use target pressure': true,
        'absolute pressure dosing': gas !== 'N2',
        pressures: [{ start_p: 0.05, end_p: 0.3, increment_p: 0.025, interval: 5 }],
        increments: null,
        options: {},
      },
    },
  };
  const body = Buffer.from(JSON.stringify(value), 'utf16le').swap16();
  const header = Buffer.alloc(8);
  header.writeInt32BE(value.analysisStatus, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
