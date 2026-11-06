import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  mcpTools,
  resultSchema,
  samWrites,
  type ClimberMcpTool,
  type SamFileInput,
} from '@auto-agent/climber-mcp/contracts';
import type { AppConfig } from '../config';

export interface ClimberReply extends Record<string, unknown> {
  error?: { code: string; message: string; outcome?: string };
}

/** One bounded stdio invocation; durable device claims belong to climber-mcp, not this client. */
export async function callClimber(
  config: Pick<AppConfig, 'dataDir' | 'climber'>,
  name: ClimberMcpTool,
  raw: Record<string, unknown>,
  context: { sessionId: string; callId: string; signal?: AbortSignal },
): Promise<ClimberReply> {
  const samOperation = name === 'sam_file' ? raw.operation : undefined;
  const writing =
    name === 'register_batch' ||
    name === 'start_batch' ||
    (name === 'sam_file' && samWrites.has(samOperation as SamFileInput['operation']));
  const operationId = createHash('sha256')
    .update(`${context.sessionId}:${context.callId}`)
    .digest('hex');
  let dispatched = false;
  const failure = (code: string, message: string): ClimberReply => ({
    error: {
      code,
      message,
      outcome: writing ? (dispatched ? 'unknown' : 'rejected') : 'unavailable',
    },
    operation: name,
    operationId,
    ...(name === 'sam_file'
      ? {
          operation: samOperation,
          ...(writing
            ? {
                writeOutcome: dispatched ? 'unknown' : 'not-started',
                targetPath: (raw.input as Record<string, unknown> | undefined)?.path ?? null,
                reconciliation:
                  '写入未确认，先核对目标路径和 SHA-256；新建省略路径时核对 profiles 的默认目录。不自动重试，取消不证明未产生文件。',
              }
            : {}),
        }
      : writing
        ? {
            batchId: raw.batchId,
            reconciliation:
              '先查询并核对原批次、阶段和操作标识；不自动重试、换编号重发或推断设备停止。',
          }
        : {}),
  });
  if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 24)
    return failure('UNSUPPORTED_RUNTIME', 'Climber MCP 需要 Node.js 24+。');
  if (name !== 'sam_file' && !config.climber.enabled)
    return failure('NOT_CONFIGURED', '请先在“设置 → 仪器”中启用 Climber 并配置厂家 /api/v1 地址。');
  const parsed = mcpTools[name].inputSchema.safeParse(raw);
  if (!parsed.success)
    return failure('INVALID_INPUT', '参数不符合 Climber MCP 工具契约，请核对本次操作字段。');
  if (
    Buffer.byteLength(JSON.stringify(name === 'sam_file' ? raw.input : raw)) >
    (name === 'sam_file' ? 16384 : 60000)
  )
    return failure('INVALID_INPUT', '参数超过 MCP 调用预算，未发送请求。');
  if (context.signal?.aborted) return failure('CANCELLED', '调用已取消，未发送请求。');

  const env: Record<string, string> = {};
  for (const key of [
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'SystemRoot',
    'WINDIR',
    'TMP',
    'TEMP',
    'TMPDIR',
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (process.env.SAM_OUTPUT_DIR) env.SAM_OUTPUT_DIR = process.env.SAM_OUTPUT_DIR;
  if (config.climber.enabled) {
    env.CLIMBER_SERVICE_URL = config.climber.serviceURL;
    env.CLIMBER_TIMEOUT_MS = String(config.climber.timeoutMs);
    env.CLIMBER_STATE_DIR = join(config.dataDir, 'climber');
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(import.meta.resolve('@auto-agent/climber-mcp/cli')),
    ],
    cwd: process.env.AUTO_AGENT_PROJECT_ROOT ?? process.cwd(),
    env,
    stderr: 'pipe',
    maxBufferSize: 256 * 1024,
  });
  const client = new Client({ name: 'auto-agent', version: '2.0.0' });
  let diagnostics = 0;
  transport.stderr?.on('data', (chunk: Buffer) => {
    diagnostics += chunk.length;
    if (diagnostics > 16384) void transport.close();
  });
  const timeout = name === 'sam_file' ? 30000 : config.climber.timeoutMs * 2 + 5000;
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(context.signal ? [context.signal] : []),
  ]);
  try {
    await client.connect(transport, { signal, timeout: 5000 });
    signal.throwIfAborted();
    dispatched = true;
    const response = await client.callTool(
      {
        name,
        arguments: parsed.data,
        _meta: {
          'auto-agent/session-id': context.sessionId,
          'auto-agent/operation-id': operationId,
        },
      },
      undefined,
      { signal, timeout, maxTotalTimeout: timeout },
    );
    const structured = response.structuredContent;
    if (!structured || typeof structured !== 'object' || Array.isArray(structured))
      return failure('INVALID_RESPONSE', 'MCP 未返回完整结构化回执，操作未确认。');
    const result = structured as Record<string, unknown>;
    if (response.isError) {
      const error = result.error as ClimberReply['error'];
      if (!error || typeof error.code !== 'string' || typeof error.message !== 'string')
        return failure('INVALID_RESPONSE', 'MCP 错误回执不完整，操作未确认。');
      return { ...result, operationId } as ClimberReply;
    }
    if (name !== 'sam_file') {
      const value = resultSchema.safeParse(result);
      if (!value.success || value.data.operation !== name)
        return failure('INVALID_RESPONSE', 'MCP 厂家回执与请求不符，操作未确认。');
      return { ...value.data, ...(writing ? { operationId } : {}) };
    }
    const backend = samWrites.has(samOperation as SamFileInput['operation'])
      ? 'sam-file-write'
      : samOperation === 'profiles'
        ? 'sam-profile-catalog'
        : 'sam-file-inspection';
    if (
      result.backend !== backend ||
      (writing && (result.written !== true || result.operation !== samOperation))
    )
      return failure('INVALID_RESPONSE', 'MCP SAM 回执与请求不符，操作未确认。');
    return result;
  } catch {
    return failure(
      context.signal?.aborted ? 'CANCELLED' : signal.aborted ? 'TIMEOUT' : 'MCP_UNAVAILABLE',
      'Climber MCP 调用未确认；写入请先核对实际文件或厂家批次，不自动重试。',
    );
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}
