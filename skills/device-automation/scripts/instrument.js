#!/usr/bin/env node

async function main() {
  // The same file runs in the repository's ESM package and in a standalone skill bundle.
  const { createRequire } = await import('node:module');
  const require = createRequire(process.argv[1]);
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { randomUUID } = require('node:crypto');
  const MAX_INPUT = 16384;
  const MAX_STATE = 2 * 1024 * 1024;
  const MAX_RECORDS = 1000;
  const devices = [
    {
      id: 'sim-analyzer-1',
      model: 'Simulation fixture analyzer 1',
      methods: ['BET', 'BJH'],
      gases: ['N2'],
    },
    {
      id: 'sim-analyzer-2',
      model: 'Simulation fixture analyzer 2',
      methods: ['BET', 'BJH', 'DFT'],
      gases: ['N2', 'CO2'],
    },
  ];
  const provenance = {
    backend: 'simulation',
    model: 'synthetic-adsorption-fixture-v1',
    description: 'Synthetic fixture data; not real measurements or scientific sample calculations.',
  };
  function fail(code, message) {
    const error = new Error(message);
    error.publicCode = code;
    throw error;
  }
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const exact = (value, keys) =>
    object(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
  const text = (value) =>
    typeof value === 'string' &&
    value.length <= 128 &&
    value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value);
  const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
  const templateKeys = [
    'name',
    'deviceId',
    'method',
    'gas',
    'temperatureK',
    'preprocessing',
    'sampleMassG',
  ];
  function templateErrors(value) {
    const errors = [];
    if (!exact(value, templateKeys))
      errors.push('Template must contain exactly the documented fields.');
    if (!object(value)) return errors;
    if (!text(value.name)) errors.push('name must be a nonempty string of at most 128 characters.');
    const device = devices.find((item) => item.id === value.deviceId);
    if (!device) errors.push('deviceId must identify a known simulation fixture.');
    if (!['BET', 'BJH', 'DFT'].includes(value.method))
      errors.push('method must be BET, BJH or DFT.');
    else if (device && !device.methods.includes(value.method))
      errors.push('method is not supported by this fixture.');
    if (!['N2', 'CO2'].includes(value.gas)) errors.push('gas must be N2 or CO2.');
    else if (device && !device.gases.includes(value.gas))
      errors.push('gas is not supported by this fixture.');
    if (!positive(value.temperatureK))
      errors.push('temperatureK must be a positive finite number.');
    if (!positive(value.sampleMassG)) errors.push('sampleMassG must be a positive finite number.');
    if (!exact(value.preprocessing, ['temperatureC', 'durationHours']))
      errors.push('preprocessing must contain exactly temperatureC and durationHours.');
    if (
      !object(value.preprocessing) ||
      typeof value.preprocessing.temperatureC !== 'number' ||
      !Number.isFinite(value.preprocessing.temperatureC) ||
      value.preprocessing.temperatureC < 0
    )
      errors.push('preprocessing.temperatureC must be a finite nonnegative number.');
    if (!object(value.preprocessing) || !positive(value.preprocessing.durationHours))
      errors.push('preprocessing.durationHours must be a positive finite number.');
    return errors;
  }
  function parse(value) {
    if (Buffer.byteLength(value, 'utf8') > MAX_INPUT)
      fail('PAYLOAD_TOO_LARGE', 'JSON payload exceeds the size limit.');
    try {
      return JSON.parse(value);
    } catch {
      fail('INVALID_JSON', 'A valid JSON payload is required.');
    }
  }
  const override = process.env.AUTO_AGENT_SIMULATION_DIR;
  if (override !== undefined && (!override || !path.isAbsolute(override)))
    fail('INVALID_CONFIGURATION', 'Simulation directory override must be absolute.');
  const root = path.resolve(
    override ?? path.join(os.homedir(), '.auto-agent', 'simulated-instruments'),
  );
  const skillRoot = path.dirname(path.dirname(path.resolve(process.argv[1])));
  const relative = path.relative(skillRoot, root);
  if (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
    fail('INVALID_CONFIGURATION', 'Simulation data must be outside the bundled skill.');
  const durationValue = process.env.AUTO_AGENT_SIMULATION_DURATION_MS ?? '1000';
  if (
    !/^\d+$/.test(durationValue) ||
    !Number.isSafeInteger(Number(durationValue)) ||
    Number(durationValue) < 1 ||
    Number(durationValue) > 600000
  )
    fail(
      'INVALID_CONFIGURATION',
      'Fixture duration must be an integer from 1 to 600000 milliseconds.',
    );
  const durationMs = Number(durationValue);
  const statePath = path.join(root, 'simulation-state.json');
  const lockPath = path.join(root, 'simulation-state.lock');
  const reportDir = path.join(root, 'simulation-local-reports');
  function inspect(target, kind) {
    const parsed = path.parse(target);
    const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let current = parsed.root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      if (stat.isSymbolicLink())
        fail('UNSAFE_PATH', 'Symbolic links are not allowed in simulation paths.');
      if (index < parts.length - 1 && !stat.isDirectory())
        fail('UNSAFE_PATH', 'Simulation path ancestors must be directories.');
      if (index === parts.length - 1) {
        if (kind === 'file' && !stat.isFile())
          fail('UNSAFE_PATH', 'Simulation file path must be a regular file.');
        if (kind === 'directory' && !stat.isDirectory())
          fail('UNSAFE_PATH', 'Simulation directory path must be a directory.');
        return stat;
      }
    }
    return fs.lstatSync(parsed.root);
  }
  function directory(target) {
    if (!inspect(target, 'directory')) {
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      inspect(target, 'directory');
    }
  }
  function readFile(target) {
    const stat = inspect(target, 'file');
    if (!stat) return null;
    if (stat.size > MAX_STATE)
      fail('STATE_TOO_LARGE', 'Persistent simulation data exceeds the size limit.');
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      inspect(target, 'file');
      if (
        !opened.isFile() ||
        opened.size > MAX_STATE ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev
      )
        fail('UNSAFE_PATH', 'Persistent simulation data is not a bounded regular file.');
      const buffer = Buffer.alloc(MAX_STATE + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_STATE)
        fail('STATE_TOO_LARGE', 'Persistent simulation data exceeds the size limit.');
      return buffer.subarray(0, size).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  const fresh = () => ({
    schemaVersion: 1,
    backend: 'simulation',
    sourceProvenance: provenance,
    templates: [],
    measurements: [],
  });
  const templateId = (id) =>
    typeof id === 'string' &&
    /^t-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
  const measurementId = (id) =>
    typeof id === 'string' &&
    /^m-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
  const fields = (template) => Object.fromEntries(templateKeys.map((key) => [key, template[key]]));
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const measurementKeys = [
    'id',
    'deviceId',
    'templateId',
    'sampleId',
    'templateSnapshot',
    'state',
    'createdAt',
    'durationMs',
    'elapsedMs',
    'runningSince',
    'completedAt',
  ];
  function validState(state) {
    if (
      !exact(state, [
        'schemaVersion',
        'backend',
        'sourceProvenance',
        'templates',
        'measurements',
      ]) ||
      state.schemaVersion !== 1 ||
      state.backend !== 'simulation' ||
      !same(state.sourceProvenance, provenance) ||
      !Array.isArray(state.templates) ||
      !Array.isArray(state.measurements) ||
      state.templates.length > MAX_RECORDS ||
      state.measurements.length > MAX_RECORDS
    )
      return false;
    const templates = new Map();
    for (const template of state.templates) {
      if (
        !exact(template, ['id', ...templateKeys]) ||
        !templateId(template.id) ||
        templates.has(template.id) ||
        templateErrors(fields(template)).length
      )
        return false;
      templates.set(template.id, template);
    }
    const ids = new Set();
    const active = new Set();
    for (const task of state.measurements) {
      if (
        !exact(task, measurementKeys) ||
        !measurementId(task.id) ||
        ids.has(task.id) ||
        !text(task.sampleId) ||
        !templates.has(task.templateId) ||
        !same(task.templateSnapshot, templates.get(task.templateId)) ||
        task.deviceId !== task.templateSnapshot.deviceId ||
        !['running', 'paused', 'cancelled', 'completed'].includes(task.state) ||
        !timestamp(task.createdAt) ||
        !Number.isSafeInteger(task.durationMs) ||
        task.durationMs < 1 ||
        task.durationMs > 600000 ||
        !timestamp(task.elapsedMs) ||
        task.elapsedMs > task.durationMs
      )
        return false;
      if (
        task.state === 'running'
          ? !timestamp(task.runningSince) ||
            task.runningSince < task.createdAt ||
            task.elapsedMs >= task.durationMs
          : task.runningSince !== null
      )
        return false;
      if (
        task.state === 'completed'
          ? !timestamp(task.completedAt) ||
            task.completedAt < task.createdAt ||
            task.elapsedMs !== task.durationMs
          : task.completedAt !== null || task.elapsedMs >= task.durationMs
      )
        return false;
      ids.add(task.id);
      if (['running', 'paused'].includes(task.state)) {
        if (active.has(task.deviceId)) return false;
        active.add(task.deviceId);
      }
    }
    return true;
  }
  function load() {
    const contents = readFile(statePath);
    if (contents === null) return fresh();
    let state;
    try {
      state = JSON.parse(contents);
    } catch {
      fail('CORRUPT_STATE', 'Persistent simulation state is malformed; no reset was performed.');
    }
    if (!validState(state))
      fail('CORRUPT_STATE', 'Persistent simulation state is invalid; no reset was performed.');
    return state;
  }
  function elapsed(task, now) {
    return Math.min(
      task.durationMs,
      task.elapsedMs + (task.state === 'running' ? Math.max(0, now - task.runningSince) : 0),
    );
  }
  function effective(task, now) {
    if (task.state !== 'running' || elapsed(task, now) < task.durationMs) return task;
    return {
      ...task,
      state: 'completed',
      elapsedMs: task.durationMs,
      runningSince: null,
      completedAt: task.runningSince + task.durationMs - task.elapsedMs,
    };
  }
  function measurement(task, now) {
    const current = effective(task, now);
    return {
      ...current,
      elapsedMs: elapsed(current, now),
      progress: Math.floor((elapsed(current, now) * 100) / current.durationMs),
    };
  }
  function deviceStatus(state, device, now) {
    const active = state.measurements
      .map((task) => effective(task, now))
      .find((task) => task.deviceId === device.id && ['running', 'paused'].includes(task.state));
    return { ...device, status: active ? 'busy' : 'idle', activeMeasurementId: active?.id ?? null };
  }
  function findTask(state, id) {
    if (!measurementId(id))
      fail('INVALID_IDENTIFIER', 'A valid measurement identifier is required.');
    const task = state.measurements.find((item) => item.id === id);
    if (!task) fail('NOT_FOUND', 'Measurement was not found.');
    return task;
  }
  function result(task) {
    if (task.state !== 'completed')
      fail('RESULTS_NOT_READY', 'Results are available only for completed measurements.');
    return {
      measurementId: task.id,
      deviceId: task.deviceId,
      templateId: task.templateId,
      sampleId: task.sampleId,
      templateSnapshot: task.templateSnapshot,
      method: task.templateSnapshot.method,
      provenance: { ...provenance, fixtureId: task.deviceId },
      units: {
        relativePressure: '1',
        adsorbedVolume: 'cm3(STP)/g',
        surfaceArea: 'm2/g',
        poreDiameter: 'nm',
        poreVolume: 'cm3/g',
      },
      summary: { surfaceArea: 123.4, poreVolume: 0.456, meanPoreDiameter: 7.8 },
      data: [0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 0.95].map((relativePressure, index) => ({
        relativePressure,
        adsorbedVolume: [12, 18, 25, 34, 47, 68, 95][index],
      })),
    };
  }
  function encoded(value) {
    const contents = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(contents) > MAX_STATE)
      fail('STATE_TOO_LARGE', 'Persistent simulation data exceeds the size limit.');
    return contents;
  }
  function atomicFile(target, contents, exclusive = false) {
    inspect(target, 'file');
    const temp = path.join(path.dirname(target), '.simulation-write-' + randomUUID() + '.tmp');
    let owned = false;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      owned = true;
      fs.writeFileSync(fd, contents);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      inspect(target, 'file');
      if (exclusive) {
        try {
          fs.linkSync(temp, target);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (readFile(target) !== contents)
            fail('REPORT_CONFLICT', 'Existing report does not match the expected fixture report.');
        }
      } else fs.renameSync(temp, target);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (owned && fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  function mutate(action) {
    directory(root);
    inspect(lockPath, 'file');
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST')
        fail(
          'STATE_LOCKED',
          'Simulation state is locked; existing locks are never reclaimed automatically.',
        );
      throw error;
    }
    const identity = fs.fstatSync(fd);
    const token = randomUUID();
    try {
      fs.writeFileSync(fd, token);
      const state = load();
      const before = JSON.stringify(state);
      const now = Date.now();
      state.measurements = state.measurements.map((task) => effective(task, now));
      const response = action(state, now);
      if (!validState(state))
        fail('INVALID_STATE', 'Mutation would create invalid simulation state.');
      if (JSON.stringify(state) !== before) atomicFile(statePath, encoded(state));
      return response;
    } finally {
      fs.closeSync(fd);
      const current = fs.lstatSync(lockPath, { throwIfNoEntry: false });
      if (
        current &&
        !current.isSymbolicLink() &&
        current.isFile() &&
        current.ino === identity.ino &&
        current.dev === identity.dev
      )
        fs.unlinkSync(lockPath);
    }
  }
  const [command, ...args] = process.argv.slice(2);
  const arities = {
    list: 0,
    status: 1,
    'validate-template': 1,
    'save-template': 1,
    'list-templates': 0,
    'get-template': 1,
    'submit-measurement': 1,
    measurement: 1,
    'control-measurement': 2,
    results: 1,
    'export-report': 1,
  };
  if (!Object.hasOwn(arities, command ?? '') || args.length !== arities[command])
    fail('INVALID_COMMAND', 'Use a documented command with its exact argument count.');
  let response;
  if (command === 'validate-template')
    response = (() => {
      const errors = templateErrors(parse(args[0]));
      return { valid: errors.length === 0, errors };
    })();
  else if (command === 'save-template') {
    const input = parse(args[0]);
    if (templateErrors(input).length)
      fail('INVALID_TEMPLATE', 'Template failed simulator structural validation.');
    response = mutate((state) => {
      if (state.templates.length >= MAX_RECORDS)
        fail('CAPACITY_EXCEEDED', 'Template capacity has been reached.');
      const template = { id: 't-' + randomUUID(), ...input };
      state.templates.push(template);
      return { template };
    });
  } else if (command === 'submit-measurement') {
    const input = parse(args[0]);
    if (
      !exact(input, ['deviceId', 'templateId', 'sampleId']) ||
      !devices.some((item) => item.id === input.deviceId) ||
      !templateId(input.templateId) ||
      !text(input.sampleId)
    )
      fail(
        'INVALID_SUBMISSION',
        'Submission must contain valid deviceId, templateId and sampleId only.',
      );
    response = mutate((state, now) => {
      const template = state.templates.find((item) => item.id === input.templateId);
      if (!template) fail('NOT_FOUND', 'Template was not found.');
      if (template.deviceId !== input.deviceId)
        fail('DEVICE_MISMATCH', 'Template and submission devices must match.');
      if (
        state.measurements.some(
          (task) => task.deviceId === input.deviceId && ['running', 'paused'].includes(task.state),
        )
      )
        fail('DEVICE_BUSY', 'Fixture already has an active measurement.');
      if (state.measurements.length >= MAX_RECORDS)
        fail('CAPACITY_EXCEEDED', 'Measurement capacity has been reached.');
      const task = {
        id: 'm-' + randomUUID(),
        ...input,
        templateSnapshot: structuredClone(template),
        state: 'running',
        createdAt: now,
        durationMs,
        elapsedMs: 0,
        runningSince: now,
        completedAt: null,
      };
      state.measurements.push(task);
      return { measurement: measurement(task, now) };
    });
  } else if (command === 'control-measurement') {
    if (!['pause', 'resume', 'cancel'].includes(args[1]))
      fail('INVALID_ACTION', 'Control action must be pause, resume or cancel.');
    response = mutate((state, now) => {
      const task = findTask(state, args[0]);
      const action = args[1];
      if (!(
        (action === 'pause' && task.state === 'running') ||
        (action === 'resume' && task.state === 'paused') ||
        (action === 'cancel' && ['running', 'paused'].includes(task.state))
      ))
        fail(
          'INVALID_TRANSITION',
          'Control action is not legal for the current measurement state.',
        );
      task.elapsedMs = elapsed(task, now);
      task.state = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled';
      task.runningSince = action === 'resume' ? now : null;
      return { measurement: measurement(task, now) };
    });
  } else if (command === 'export-report') {
    response = mutate((state) => {
      const task = findTask(state, args[0]);
      const data = result(task);
      const id = 'r-' + task.id;
      const report = {
        id,
        path: path.join(reportDir, id + '.json'),
        measurementId: task.id,
        format: 'json',
      };
      directory(reportDir);
      atomicFile(
        report.path,
        encoded({
          schemaVersion: 1,
          backend: 'simulation',
          sourceProvenance: provenance,
          report,
          result: data,
        }),
        true,
      );
      return { report };
    });
  } else {
    const state = load();
    const now = Date.now();
    if (command === 'list')
      response = { devices: devices.map((device) => deviceStatus(state, device, now)) };
    else if (command === 'status') {
      const device = devices.find((item) => item.id === args[0]);
      if (!device) fail('NOT_FOUND', 'Device was not found.');
      response = { device: deviceStatus(state, device, now) };
    } else if (command === 'list-templates') response = { templates: state.templates };
    else if (command === 'get-template') {
      if (!templateId(args[0]))
        fail('INVALID_IDENTIFIER', 'A valid template identifier is required.');
      const template = state.templates.find((item) => item.id === args[0]);
      if (!template) fail('NOT_FOUND', 'Template was not found.');
      response = { template };
    } else {
      const task = effective(findTask(state, args[0]), now);
      response =
        command === 'measurement'
          ? { measurement: measurement(task, now) }
          : { result: result(task) };
    }
  }
  process.stdout.write(JSON.stringify(response) + '\n');
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      error: {
        code: error.publicCode ?? 'IO_ERROR',
        message: error.publicCode ? error.message : 'Simulation storage operation failed.',
      },
    }) + '\n',
  );
  process.exitCode = 1;
});
