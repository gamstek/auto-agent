import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type {
  CallToolResult,
  ServerRequest,
  ServerNotification,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { inputs, VendorError, type ClimberTool } from './vendor';
import { ClimberController } from './controller';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { version } from '../package.json';

export async function serveClimber() {
  const baseURL = process.env.CLIMBER_SERVICE_URL ?? '';
  const url = new URL(baseURL);
  const timeoutMs = Number(process.env.CLIMBER_TIMEOUT_MS ?? '5000');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/api\/v1\/?$/.test(url.pathname) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60000
  )
    throw new Error('Invalid Climber configuration');
  const server = new McpServer({ name: 'climber-mcp', version });
  const controller = new ClimberController(
    baseURL,
    timeoutMs,
    process.env.CLIMBER_STATE_DIR
      ? resolve(process.env.CLIMBER_STATE_DIR)
      : join(homedir(), '.climber-mcp'),
  );
  const clientOwner = randomUUID();
  for (const name of Object.keys(inputs) as ClimberTool[]) {
    server.registerTool(
      name,
      {
        description: {
          get_health: '查询 Climber 厂家软件就绪与设备连接状态',
          get_status: '查询 Climber 当前批次与健康状态；无历史任务查询',
          register_batch:
            '登记左侧1–3项实验，不启动；samPath 必须为厂家主机可读的 Windows 绝对 .SAM 文件，内容须为常规模式 labType=0',
          start_batch: '启动已明确登记成功的 batchId；超时或身份不明不得重试',
        }[name],
        inputSchema: inputs[name],
        annotations: { readOnlyHint: name.startsWith('get_') },
      },
      async (
        input: unknown,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
      ): Promise<CallToolResult> => {
        try {
          const owner =
            typeof extra._meta?.['auto-agent/session-id'] === 'string'
              ? extra._meta['auto-agent/session-id']
              : clientOwner;
          const operationId =
            typeof extra._meta?.['auto-agent/operation-id'] === 'string'
              ? extra._meta['auto-agent/operation-id']
              : randomUUID();
          const result = await controller.execute(name, input, owner, operationId, extra.signal);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          const failure =
            error instanceof VendorError
              ? {
                  code: error.code,
                  outcome: error.outcome,
                  message: error.message,
                  ...(error.vendorCode ? { vendorCode: error.vendorCode } : {}),
                }
              : { code: 'INVALID_INPUT', outcome: 'rejected', message: '输入参数无效' };
          return {
            isError: true,
            content: [{ type: 'text', text: failure.message }],
            structuredContent: { error: failure },
          };
        }
      },
    );
  }
  server.registerTool(
    'reconcile_operation',
    {
      description:
        '操作者核对：仅释放本服务的设备预留，不停止仪器，不重放未知批次。默认不提供给 Agent。',
      inputSchema: z
        .object({ operationId: z.string().min(1).max(128), note: z.string().min(1).max(2000) })
        .strict(),
    },
    async ({ operationId, note }, extra) => {
      try {
        const result = await controller.reconcile(operationId, note, extra.signal);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch {
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: '无法完成设备核对，请检查原操作和厂家当前状态' },
          ],
        };
      }
    },
  );
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 }),
  );
  process.stdin.once('end', () => void server.close());
}
