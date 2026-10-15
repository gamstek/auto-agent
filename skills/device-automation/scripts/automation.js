#!/usr/bin/env node

async function main() {
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
      id: 'sim-automation-1',
      model: '模拟自动化设备 1',
      kind: 'preset-workflow',
      methods: ['BET', 'BJH'],
      gases: ['N2'],
    },
    {
      id: 'sim-automation-2',
      model: '模拟自动化设备 2',
      kind: 'preset-workflow',
      methods: ['BET', 'BJH', 'DFT'],
      gases: ['N2', 'CO2'],
    },
  ];
  const provenance = {
    backend: 'simulation',
    model: 'synthetic-adsorption-fixture-v1',
    description: '合成模拟数据，不是真实测量或样品科学性质的计算。',
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
  const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;
  function parse(value) {
    if (Buffer.byteLength(value, 'utf8') > MAX_INPUT)
      fail('PAYLOAD_TOO_LARGE', 'JSON 载荷超过大小限制。');
    try {
      return JSON.parse(value);
    } catch {
      fail('INVALID_JSON', '必须提供有效的 JSON 载荷。');
    }
  }
  const override = process.env.AUTO_AGENT_SIMULATION_DIR;
  if (override !== undefined && (!override || !path.isAbsolute(override)))
    fail('INVALID_CONFIGURATION', '模拟数据目录必须为绝对路径。');
  const root = path.resolve(
    override ?? path.join(os.homedir(), '.auto-agent', 'simulated-automation'),
  );
  const skillRoot = path.dirname(path.dirname(path.resolve(process.argv[1])));
  const relative = path.relative(skillRoot, root);
  if (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
    fail('INVALID_CONFIGURATION', '模拟数据必须位于技能包目录之外。');
  const durationValue = process.env.AUTO_AGENT_SIMULATION_DURATION_MS ?? '1000';
  if (
    !/^\d+$/.test(durationValue) ||
    !Number.isSafeInteger(Number(durationValue)) ||
    Number(durationValue) < 1 ||
    Number(durationValue) > 600000
  )
    fail('INVALID_CONFIGURATION', '模拟时长必须为 1 至 600000 毫秒的整数。');
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
      if (stat.isSymbolicLink()) fail('UNSAFE_PATH', '模拟路径不允许包含符号链接。');
      if (index < parts.length - 1 && !stat.isDirectory())
        fail('UNSAFE_PATH', '模拟路径的上级路径必须为目录。');
      if (index === parts.length - 1) {
        if (kind === 'file' && !stat.isFile())
          fail('UNSAFE_PATH', '模拟文件路径必须指向普通文件。');
        if (kind === 'directory' && !stat.isDirectory())
          fail('UNSAFE_PATH', '模拟目录路径必须指向目录。');
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
    if (stat.size > MAX_STATE) fail('STATE_TOO_LARGE', '持久化模拟数据超过大小限制。');
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
        fail('UNSAFE_PATH', '持久化模拟数据必须为大小受限的普通文件。');
      const buffer = Buffer.alloc(MAX_STATE + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_STATE) fail('STATE_TOO_LARGE', '持久化模拟数据超过大小限制。');
      return buffer.subarray(0, size).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  const fresh = () => ({
    schemaVersion: 1,
    backend: 'simulation',
    kind: 'preset-workflow',
    sourceProvenance: provenance,
    runs: [],
  });
  const runId = (id) =>
    typeof id === 'string' &&
    /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const runKeys = [
    'id',
    'deviceId',
    'templateFile',
    'state',
    'createdAt',
    'durationMs',
    'elapsedMs',
    'runningSince',
    'completedAt',
  ];
  const filename = (value) =>
    text(value) &&
    value === value.trim() &&
    !/[<>:"/\\|?*]/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.endsWith('.');
  function validState(state) {
    if (
      !exact(state, ['schemaVersion', 'backend', 'kind', 'sourceProvenance', 'runs']) ||
      state.schemaVersion !== 1 ||
      state.backend !== 'simulation' ||
      state.kind !== 'preset-workflow' ||
      !same(state.sourceProvenance, provenance) ||
      !Array.isArray(state.runs) ||
      state.runs.length > MAX_RECORDS
    )
      return false;
    const ids = new Set();
    const active = new Set();
    for (const task of state.runs) {
      if (
        !exact(task, runKeys) ||
        !runId(task.id) ||
        ids.has(task.id) ||
        !filename(task.templateFile) ||
        !devices.some((device) => device.id === task.deviceId) ||
        !['running', 'completed'].includes(task.state) ||
        !timestamp(task.createdAt) ||
        !Number.isSafeInteger(task.durationMs) ||
        task.durationMs < 1 ||
        task.durationMs > 600000 ||
        !timestamp(task.elapsedMs) ||
        task.elapsedMs > task.durationMs ||
        (task.state === 'running'
          ? !timestamp(task.runningSince) ||
            task.runningSince < task.createdAt ||
            task.elapsedMs >= task.durationMs ||
            task.completedAt !== null
          : task.runningSince !== null ||
            !timestamp(task.completedAt) ||
            task.completedAt < task.createdAt ||
            task.elapsedMs !== task.durationMs)
      )
        return false;
      ids.add(task.id);
      if (task.state === 'running') {
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
      fail('CORRUPT_STATE', '持久化模拟状态格式损坏，未执行重置。');
    }
    if (!validState(state)) fail('CORRUPT_STATE', '持久化模拟状态无效，未执行重置。');
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
  function run(task, now) {
    const current = effective(task, now);
    return {
      ...current,
      elapsedMs: elapsed(current, now),
      progress: Math.floor((elapsed(current, now) * 100) / current.durationMs),
    };
  }
  function deviceStatus(state, device, now) {
    const active = state.runs
      .map((task) => effective(task, now))
      .find((task) => task.deviceId === device.id && task.state === 'running');
    return { ...device, status: active ? 'busy' : 'idle', activeRunId: active?.id ?? null };
  }
  function findTask(state, id) {
    if (!runId(id)) fail('INVALID_IDENTIFIER', '必须提供有效的流程运行标识。');
    const task = state.runs.find((item) => item.id === id);
    if (!task) fail('NOT_FOUND', '未找到流程运行。');
    return task;
  }
  function result(task, sourceProvenance) {
    if (task.state !== 'completed') fail('RESULTS_NOT_READY', '仅已完成的流程运行可获取结果。');
    return {
      runId: task.id,
      deviceId: task.deviceId,
      templateFile: task.templateFile,
      provenance: { ...sourceProvenance, fixtureId: task.deviceId },
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
      fail('STATE_TOO_LARGE', '持久化模拟数据超过大小限制。');
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
            fail('REPORT_CONFLICT', '已有报告与预期的模拟报告不一致。');
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
      if (error.code === 'EEXIST') fail('STATE_LOCKED', '模拟状态已锁定，不会自动回收已有锁。');
      throw error;
    }
    const identity = fs.fstatSync(fd);
    const token = randomUUID();
    try {
      fs.writeFileSync(fd, token);
      const state = load();
      const before = JSON.stringify(state);
      const now = Date.now();
      state.runs = state.runs.map((task) => effective(task, now));
      const response = action(state, now);
      if (!validState(state)) fail('INVALID_STATE', '写操作将产生无效的模拟状态。');
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
    'submit-run': 1,
    run: 1,
    results: 1,
    'export-report': 1,
  };
  if (!Object.hasOwn(arities, command ?? '') || args.length !== arities[command])
    fail('INVALID_COMMAND', '请使用文档规定的命令及准确的参数数量。');
  let response;
  if (command === 'submit-run') {
    const input = parse(args[0]);
    if (
      !exact(input, ['deviceId', 'templateFile']) ||
      !devices.some((item) => item.id === input.deviceId) ||
      !filename(input.templateFile)
    )
      fail('INVALID_SUBMISSION', '提交数据必须且只能包含有效的 deviceId 和 templateFile。');
    response = mutate((state, now) => {
      if (state.runs.some((task) => task.deviceId === input.deviceId && task.state === 'running'))
        fail('DEVICE_BUSY', '模拟自动化设备已有活动流程。');
      if (state.runs.length >= MAX_RECORDS)
        fail('CAPACITY_EXCEEDED', '流程运行数量已达到容量上限。');
      const task = {
        id: 'run-' + randomUUID(),
        ...input,
        state: 'running',
        createdAt: now,
        durationMs,
        elapsedMs: 0,
        runningSince: now,
        completedAt: null,
      };
      state.runs.push(task);
      return { run: run(task, now) };
    });
  } else if (command === 'export-report') {
    if (!runId(args[0])) fail('INVALID_IDENTIFIER', '必须提供有效的流程运行标识。');
    response = mutate((state) => {
      const task = findTask(state, args[0]);
      const data = result(task, state.sourceProvenance);
      const id = 'r-' + task.id;
      const report = {
        id,
        path: path.join(reportDir, id + '.json'),
        runId: task.id,
        format: 'json',
      };
      directory(reportDir);
      atomicFile(
        report.path,
        encoded({
          schemaVersion: 1,
          backend: 'simulation',
          sourceProvenance: state.sourceProvenance,
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
      if (!device) fail('NOT_FOUND', '未找到设备。');
      response = { device: deviceStatus(state, device, now) };
    } else {
      const task = effective(findTask(state, args[0]), now);
      response =
        command === 'run'
          ? { run: run(task, now) }
          : { result: result(task, state.sourceProvenance) };
    }
  }
  process.stdout.write(JSON.stringify({ backend: 'simulation', ...response }) + '\n');
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      error: {
        code: error.publicCode ?? 'IO_ERROR',
        message: error.publicCode ? error.message : '模拟数据存储操作失败。',
      },
    }) + '\n',
  );
  process.exitCode = 1;
});
