#!/usr/bin/env node

// Real Climber access goes through the Python subservice, never the vendor API directly.
async function main() {
  const fail = (code, message, details = {}) => {
    throw Object.assign(new Error(message), { code, details });
  };
  const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const exact = (v, keys) =>
    object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
  const text = (v, max) =>
    typeof v === 'string' &&
    v.trim().length > 0 &&
    v.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(v);
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const [command, ...args] = process.argv.slice(2);
  const reads = {
    health: '/health',
    status: '/status',
    'vendor-health': '/api/v1/health',
    'vendor-status': '/api/v1/status',
    results: '/results',
  };
  const localCommands = {
    resume: 'RESUME',
    'clear-error': 'CLEAR_ERROR',
    'status-poll': 'STATUS_POLL',
  };
  if (
    !Object.hasOwn(reads, command) &&
    command !== 'start' &&
    !Object.hasOwn(localCommands, command)
  )
    fail(
      'INVALID_COMMAND',
      '支持 health、status、vendor-health、vendor-status、results、start、resume、clear-error、status-poll。',
    );
  const write = !Object.hasOwn(reads, command);
  if (args.length !== (write ? 1 : 0))
    fail('INVALID_ARGUMENTS', '写命令需要一个 JSON 参数，只读命令不接受参数。');
  let input;
  if (write) {
    if (Buffer.byteLength(args[0], 'utf8') > 16384) fail('INVALID_INPUT', 'JSON 超过 16384 字节。');
    try {
      input = JSON.parse(args[0]);
    } catch {
      fail('INVALID_INPUT', '参数必须是有效 JSON。');
    }
    if (
      !exact(input, ['commandId', 'payload']) ||
      !text(input.commandId, 128) ||
      !object(input.payload)
    )
      fail(
        'INVALID_INPUT',
        '需要 commandId 和 payload；commandId 必须是非空字符串（最多 128 字符）。',
      );
    if (command === 'start') {
      const p = input.payload;
      if (
        !exact(p, ['taskId', 'stationId', 'experiments']) ||
        typeof p.taskId !== 'string' ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(p.taskId) ||
        !text(p.stationId, 128) ||
        !Array.isArray(p.experiments) ||
        p.experiments.length < 1 ||
        p.experiments.length > 3
      )
        fail('INVALID_INPUT', 'START 需要 taskId、stationId 及左侧 1 至 3 项 experiments。');
      const ids = new Set(),
        ports = new Set(),
        tubes = new Set();
      for (const e of p.experiments) {
        if (
          !exact(e, [
            'experimentId',
            'analysisPort',
            'tubeNo',
            'samPath',
            'sampleName',
            'emptyTubeMassG',
            'sampleMassG',
          ]) ||
          !text(e.experimentId, 128) ||
          ![1, 2, 3].includes(e.analysisPort) ||
          !Number.isSafeInteger(e.tubeNo) ||
          e.tubeNo <= 0 ||
          !text(e.samPath, 4096) ||
          !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]).+\.sam$/i.test(e.samPath) ||
          !text(e.sampleName, 128) ||
          /[<>:"/\\|?*]/.test(e.sampleName) ||
          !positive(e.emptyTubeMassG) ||
          !positive(e.sampleMassG)
        )
          fail(
            'INVALID_INPUT',
            '实验字段不合法：仅支持左口 1/2/3、正整数管号、绝对 SAM 路径、合法样品名和正有限质量（g）。',
          );
        const tube = e.tubeNo % 72 || 72;
        if (ids.has(e.experimentId) || ports.has(e.analysisPort) || tubes.has(tube))
          fail('INVALID_INPUT', '实验编号、分析口和取余后的接口管号不得重复。');
        ids.add(e.experimentId);
        ports.add(e.analysisPort);
        tubes.add(tube);
      }
    }
  }
  let base;
  try {
    base = new URL(process.env.CLIMBER_SERVICE_URL);
  } catch {
    fail('INVALID_CONFIGURATION', '必须配置 CLIMBER_SERVICE_URL 为 Python 子服务地址。');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  )
    fail('INVALID_CONFIGURATION', '子服务地址必须是无凭据、路径或查询参数的 HTTP(S) 源地址。');
  const timeout = process.env.CLIMBER_TIMEOUT_MS ?? '5000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 60000)
    fail('INVALID_CONFIGURATION', 'CLIMBER_TIMEOUT_MS 必须为 1 至 60000 的整数。');
  const identity = write
    ? {
        commandId: input.commandId,
        ...(command === 'start' ? { taskId: input.payload.taskId } : {}),
      }
    : {};
  let response, body;
  try {
    response = await fetch(new URL(write ? '/commands' : reads[command], base), {
      method: write ? 'POST' : 'GET',
      headers: write ? { 'Content-Type': 'application/json' } : {},
      ...(write
        ? {
            body: JSON.stringify({
              commandId: input.commandId,
              commandType: command === 'start' ? 'CLIMBER_ANALYZER_START' : localCommands[command],
              payload: input.payload,
            }),
          }
        : {}),
      signal: AbortSignal.timeout(Number(timeout)),
      redirect: 'error',
    });
    body = await response.json();
  } catch {
    fail(
      write ? 'OUTCOME_UNKNOWN' : 'SERVICE_UNAVAILABLE',
      write ? '命令效果未知；只读查询并由操作者对账，不得自动重发。' : '无法取得子服务 JSON 响应。',
      identity,
    );
  }
  if (!object(body))
    fail(write ? 'OUTCOME_UNKNOWN' : 'INVALID_RESPONSE', '子服务响应必须为 JSON 对象。', identity);
  if (write) {
    if (
      body.commandId !== input.commandId ||
      typeof body.accepted !== 'boolean' ||
      typeof body.workStatus !== 'string'
    )
      fail('OUTCOME_UNKNOWN', '命令回执缺失字段或身份不匹配；不得自动重发。', identity);
    if (!body.accepted)
      fail('COMMAND_REJECTED', '子服务拒绝命令。', { ...identity, response: body });
    if (!response.ok) fail('OUTCOME_UNKNOWN', 'HTTP 状态与受理回执矛盾；请只读对账。', identity);
  } else if (!response.ok || body.ok === false) {
    fail('SERVICE_ERROR', '子服务查询失败。', { status: response.status, response: body });
  }
  console.log(
    JSON.stringify({
      backend: 'climber-subservice',
      operation: command,
      ...identity,
      response: body,
    }),
  );
}

main().catch((error) => {
  console.log(
    JSON.stringify({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: error.code ? error.message : 'Climber 接口调用失败。',
        ...error.details,
      },
    }),
  );
  process.exitCode = 1;
});
