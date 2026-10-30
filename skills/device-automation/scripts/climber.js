#!/usr/bin/env node

import { skillLog } from './lib/log.js';

// Direct access to the manufacturer's Climber PC HTTP API.
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
  const samFilePath = (v) => text(v, 4096) && /^[A-Za-z]:[\\/].+\.sam$/i.test(v);
  const batchId = (v) =>
    typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v) && !['.', '..'].includes(v);
  const [command, ...args] = process.argv.slice(2);
  if (!['health', 'status', 'register', 'start'].includes(command))
    fail('INVALID_COMMAND', '支持 health、status、register、start。');
  const write = command === 'register' || command === 'start';
  if (args.length !== (write ? 1 : 0))
    fail('INVALID_ARGUMENTS', 'register/start 需要一个 JSON 参数；health/status 不接受参数。');
  let input;
  const tubeMapping = [];
  if (write) {
    if (Buffer.byteLength(args[0], 'utf8') > 16384) fail('INVALID_INPUT', 'JSON 超过 16384 字节。');
    try {
      input = JSON.parse(args[0]);
    } catch {
      fail('INVALID_INPUT', '参数必须是有效 JSON。');
    }
    if (
      !exact(input, command === 'register' ? ['batchId', 'experiments'] : ['batchId']) ||
      !batchId(input.batchId)
    )
      fail(
        'INVALID_INPUT',
        '需要 batchId（1–64位字母、数字、点、下划线或连字符，不得为点路径段）；register 还需要 experiments。',
      );
    if (command === 'register') {
      if (
        !Array.isArray(input.experiments) ||
        input.experiments.length < 1 ||
        input.experiments.length > 3
      )
        fail('INVALID_INPUT', '登记需要左侧1–3项 experiments。');
      const ids = new Set(),
        ports = new Set(),
        tubes = new Set();
      for (const e of input.experiments) {
        if (object(e) && !samFilePath(e.samPath))
          fail(
            'INVALID_INPUT',
            'samPath 必须是Windows盘符开头、包含文件名的绝对 .SAM 文件路径，例如 E:/templates/example.SAM，不能传目录或网络路径。',
          );
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
          !text(e.sampleName, 128) ||
          /[<>:"/\\|?*]/.test(e.sampleName) ||
          !positive(e.emptyTubeMassG) ||
          !positive(e.sampleMassG)
        )
          fail(
            'INVALID_INPUT',
            '实验字段不合法：仅支持左口1/2/3、正整数管号、绝对SAM路径、合法样品名和正有限质量（g）。',
          );
        const tube = e.tubeNo % 72 || 72;
        if (ids.has(e.experimentId) || ports.has(e.analysisPort) || tubes.has(tube))
          fail('INVALID_INPUT', '实验编号、分析口和取余后的接口管号不得重复。');
        ids.add(e.experimentId);
        ports.add(e.analysisPort);
        tubes.add(tube);
        tubeMapping.push({ experimentId: e.experimentId, tubeNo: e.tubeNo, vendorTubeNo: tube });
      }
    }
  }
  let base;
  try {
    base = new URL(process.env.CLIMBER_SERVICE_URL);
  } catch {
    fail('INVALID_CONFIGURATION', '必须配置 CLIMBER_SERVICE_URL 为厂家 HTTP API 基址。');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    !['/api/v1', '/api/v1/'].includes(base.pathname) ||
    base.search ||
    base.hash
  )
    fail(
      'INVALID_CONFIGURATION',
      '厂家API地址必须为无凭据和查询参数、以 /api/v1 结尾的 HTTP(S) 基址。',
    );
  base.pathname = '/api/v1/';
  const timeout = process.env.CLIMBER_TIMEOUT_MS ?? '5000';
  if (!/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 60000)
    fail('INVALID_CONFIGURATION', 'CLIMBER_TIMEOUT_MS 必须为1–60000的整数。');
  const identity = write
    ? { batchId: input.batchId, stage: command, ...(command === 'register' ? { tubeMapping } : {}) }
    : {};
  const route =
    command === 'register'
      ? 'tasks'
      : command === 'start'
        ? `tasks/${encodeURIComponent(input.batchId)}/start`
        : command;
  const started = Date.now();
  const requestDetails = {
    operation: command,
    ...identity,
    endpoint: base.href,
    route,
    method: write ? 'POST' : 'GET',
    timeoutMs: Number(timeout),
  };
  skillLog('http.request', requestDetails);
  let response, body;
  let phase = 'transport';
  try {
    response = await fetch(new URL(route, base), {
      method: write ? 'POST' : 'GET',
      headers: write ? { 'Content-Type': 'application/json' } : {},
      ...(write
        ? {
            body: JSON.stringify(
              command === 'register'
                ? {
                    batchId: input.batchId,
                    experiments: input.experiments.map((experiment, index) => ({
                      ...experiment,
                      tubeNo: tubeMapping[index].vendorTubeNo,
                    })),
                  }
                : {},
            ),
          }
        : {}),
      signal: AbortSignal.timeout(Number(timeout)),
      redirect: 'error',
    });
    phase = 'decode';
    body = await response.json();
  } catch (error) {
    const cause = {
      name: error?.name,
      message: String(error?.message ?? error).slice(0, 1000),
      code: error?.cause?.code,
    };
    const diagnostic = {
      ...requestDetails,
      phase,
      durationMs: Date.now() - started,
      status: response?.status,
      cause,
    };
    skillLog('http.failed', diagnostic);
    fail(
      write ? 'OUTCOME_UNKNOWN' : 'SERVICE_UNAVAILABLE',
      write
        ? '厂家请求效果未知；保留批次与阶段，只读对账，不得自动重发。'
        : '无法取得厂家API的JSON响应。',
      { ...identity, diagnostic },
    );
  }
  const fieldTypes = (value) =>
    object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .slice(0, 32)
            .map((key) => [
              key.slice(0, 128),
              value[key] === null
                ? 'null'
                : Array.isArray(value[key])
                  ? 'array'
                  : typeof value[key],
            ]),
        )
      : typeof value;
  const metadata = (value) =>
    typeof value === 'string'
      ? value.slice(0, 256)
      : value === null || ['boolean', 'number'].includes(typeof value)
        ? value
        : typeof value;
  const taskIdentity = (value) =>
    object(value)
      ? {
          ...Object.fromEntries(
            ['batchId', 'state', 'analysisStarted', 'templateSha256']
              .filter((key) => Object.hasOwn(value, key))
              .map((key) => [key, metadata(value[key])]),
          ),
          ...(Array.isArray(value.experiments)
            ? {
                experiments: value.experiments
                  .slice(0, 3)
                  .map((experiment) =>
                    object(experiment)
                      ? Object.fromEntries(
                          ['experimentId', 'analysisPort', 'state', 'deviceRunId', 'templateSha256']
                            .filter((key) => Object.hasOwn(experiment, key))
                            .map((key) => [key, metadata(experiment[key])]),
                        )
                      : null,
                  ),
              }
            : {}),
        }
      : null;
  const responseSummary = {
    ok: metadata(body?.ok),
    rootFields: fieldTypes(body),
    dataFields: fieldTypes(body?.data),
    directTask: taskIdentity(body?.data),
    nestedTask: taskIdentity(body?.data?.task),
    ...(object(body?.error)
      ? {
          error: {
            code: metadata(body.error.code),
            message:
              typeof body.error.message === 'string'
                ? body.error.message.slice(0, 1000)
                : typeof body.error.message,
          },
        }
      : {}),
  };
  const diagnostic = {
    ...requestDetails,
    phase: 'validate',
    status: response.status,
    durationMs: Date.now() - started,
    responseSummary,
  };
  skillLog('http.response', diagnostic);
  const uncertain = (message, reason = 'invalid_response') =>
    fail(write ? 'OUTCOME_UNKNOWN' : 'INVALID_RESPONSE', message, {
      ...identity,
      status: response.status,
      diagnostic: { ...diagnostic, reason },
    });
  if (!object(body)) uncertain('厂家响应必须为JSON对象。');
  if (
    body.ok === false &&
    object(body.error) &&
    text(body.error.code, 128) &&
    text(body.error.message, 4096)
  )
    fail(write ? 'COMMAND_REJECTED' : 'SERVICE_ERROR', '厂家拒绝请求。', {
      ...identity,
      status: response.status,
      response: body,
      diagnostic,
    });
  if (!response.ok || body.ok !== true || !object(body.data))
    uncertain('厂家HTTP状态或 ok/data 封套无效；写请求不得自动重发。');
  if (write) {
    // The documented v1 start replies include both data and data.task forms.
    // Normalize only these known forms; conflicting identities remain uncertain.
    const nested = object(body.data.task) ? body.data.task : null;
    if (
      command === 'start' &&
      nested &&
      ((Object.hasOwn(body.data, 'batchId') && body.data.batchId !== nested.batchId) ||
        (Object.hasOwn(body.data, 'state') && body.data.state !== nested.state))
    )
      uncertain(
        '厂家启动回执的两处任务身份或状态矛盾；请只读对账，不得自动重发。',
        'conflicting_tasks',
      );
    const task = command === 'register' ? body.data.task : (nested ?? body.data);
    if (!object(task) || task.batchId !== input.batchId || !text(task.state, 128))
      uncertain(
        '厂家任务回执缺少批次/状态或批次不匹配；请只读对账，不得自动重发。',
        'task_identity',
      );
  } else if (command === 'status') {
    if (
      !object(body.data.health) ||
      !(
        body.data.task === null ||
        (object(body.data.task) &&
          text(body.data.task.batchId, 64) &&
          text(body.data.task.state, 128))
      )
    )
      uncertain('厂家status需要 data.health 和 data.task（任务对象或null）。');
  }
  skillLog('command.completed', {
    operation: command,
    ...identity,
    status: response.status,
    durationMs: Date.now() - started,
  });
  console.log(
    JSON.stringify({ backend: 'climber-vendor', operation: command, ...identity, response: body }),
  );
}

main().catch((error) => {
  skillLog('command.failed', {
    code: error.code ?? 'INTERNAL_ERROR',
    message: error.message,
    batchId: error.details?.batchId,
    stage: error.details?.stage,
    diagnostic: error.details?.diagnostic,
  });
  console.log(
    JSON.stringify({
      error: {
        code: error.code ?? 'INTERNAL_ERROR',
        message: error.code ? error.message : 'Climber 厂家接口调用失败。',
        ...error.details,
      },
    }),
  );
  process.exitCode = 1;
});
