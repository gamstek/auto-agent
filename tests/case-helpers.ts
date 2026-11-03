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

export function referenceSamFixture() {
  const root = JSON.parse(new TextDecoder('utf-16be').decode(samFixture().subarray(8)));
  root.labType = 1;
  root['base infos'] = [
    { title: 'Operator', value: 'DO_NOT_INDEX_OPERATOR' },
    { title: 'Pretreatment', value: 'REFERENCE_PRETREATMENT 真空350℃，6小时' },
    { title: '处理条件', value: '保留第二条条件原文' },
  ];
  root.mass.density = 1.2;
  root.mass.isEnter = false;
  root['sample tube'] = {
    name: '1/2 Tube',
    'use isothermal jacket': true,
    'use filter rod': false,
    'ambient free space': 1,
  };
  root['analysis conditions']['adsorptive properties'] = {
    mnemonic: 'N2',
    id: 2,
    'gas type': 2,
    'molecular cross sectional area': 0.162,
    'fluid properties file': 'C:\\Users\\original\\models\\N2.FPI',
  };
  root['analysis conditions']['p0 and temperature options'].p0 = 760;
  root['analysis conditions']['p0 and temperature options']['choose one option'] = 2;
  root['analysis conditions']['preparation options'] = {
    'evacuation time': 1.25,
    'leak test': false,
    'leak test duration': 0,
  };
  root['analysis conditions']['sample backfill options'] = {
    'backfill sample at start of analysis': false,
    'backfill gas': 1,
  };
  root['analysis conditions']['isotherm collection'].options = {
    'first dose isActive': false,
    'first pressure fixed dose': 0,
    'relative pressure tolerance': 2,
    T_LPressIncrementalDoseMode: true,
    T_DoseAmount: 0,
    T_MinEquilibrationDelay: 0.5,
    D_LPressIncrementalDoseMode: true,
    D_DoseAmount: 25,
  };
  root.reports = [
    {
      type: 6,
      options: {
        type: 6,
        name: 'BET',
        selected: true,
        fitRange: { min: 0.045, max: 0.31 },
        BETSmartPointSelection: false,
        RouquerolCriterion1: true,
        surfaceArea: 987654321,
        min_i: 5,
        bet_areas: [87654321],
        isothermPlotOptions: { color: 'DO_NOT_INDEX_PLOT' },
      },
    },
    {
      type: 17,
      options: {
        type: 17,
        name: 'Horvath-Kawazoe',
        selected: true,
        computed: true,
        computedInteractionParameter: 7654321,
        currentAdsorptive: 2,
      },
    },
    {
      type: 18,
      options: {
        type: 18,
        name: 'DFT Advanced PSD',
        selected: false,
        selectedFile: {
          filePathName: 'C:\\Users\\original\\kernels\\zzinactivekerneluniquerefzz.kernel',
          sampleName: 'DO_NOT_INDEX_OLD_SAMPLE',
          geometry: 1,
        },
        poreVolumes: [2, 50],
        optRMSError: 654321,
      },
    },
  ];
  root['analysis data'] = { secret: 'DO_NOT_INDEX_TRAJECTORY' };
  const body = Buffer.from(JSON.stringify(root), 'utf16le').swap16();
  const header = Buffer.alloc(8);
  header.writeInt32BE(root.analysisStatus, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
