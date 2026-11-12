import {
  defineDynamic,
  defineTool,
  defineDurableSchema,
  defineDurableCallback,
} from '@coraxjs/core/tools';
import type { ApprovalContext } from '@coraxjs/core/tools/approval';
import { mcpTools } from '@auto-agent/climber-mcp/contracts';
import { callClimber } from '../lib/climber';
import { climberToolCatalog } from '../lib/climber/catalog';
import { getRuntimeConfig } from '../lib/config';
import { climberApproval } from '../lib/approval';

export default defineDynamic({
  events: {
    'step.started': () => {
      const config = getRuntimeConfig();
      return Object.fromEntries(
        climberToolCatalog(config).map(({ operation: name, name: toolName }) => [
          toolName,
          defineTool({
            ...mcpTools[name],
            inputSchema: defineDurableSchema({
              closure: { name },
              schema: ({ name }) => mcpTools[name].inputSchema,
            }),
            label: { start: () => (name === 'sam_file' ? 'SAM 文件操作' : `Climber：${name}`) },
            approval: {
              request: defineDurableCallback({
                closure: { name },
                callback: ({ name }, context: ApprovalContext) =>
                  climberApproval(name, context.toolInput, context),
              }),
              prompt: defineDurableCallback({
                closure: { name },
                callback: ({ name }) =>
                  name === 'sam_file'
                    ? '即将写入 SAM 文件。请核对操作、目标路径和参数；批准文件写入不代表批准登记或启动仪器。'
                    : name === 'register_batch'
                      ? '即将向 Climber 登记批次，不会启动。请核对批次、实验、管号和 SAM 路径。'
                      : '即将启动 Climber 批次。请核对批次身份及已确认的实验条件；取消对话不代表仪器停止。',
              }),
            },
            async execute(input, context) {
              return JSON.stringify(
                await callClimber(config, name, input, {
                  sessionId: context.session.id,
                  callId: context.callId,
                  signal: context.abortSignal,
                }),
              );
            },
          }),
        ]),
      );
    },
  },
});
