import { defineDynamic, defineTool, defineDurableSchema } from '@coraxjs/core/tools';
import { mcpTools, type ClimberMcpTool } from '@auto-agent/climber-mcp/contracts';
import { callClimber } from '../lib/climber';
import { getRuntimeConfig } from '../lib/config';

export default defineDynamic({
  events: {
    'step.started': () => {
      const config = getRuntimeConfig();
      return Object.fromEntries(
        (Object.keys(mcpTools) as ClimberMcpTool[])
          .filter((name) => name === 'sam_file' || config.climber.enabled)
          .map((name) => [
            name === 'sam_file' ? name : `climber_${name}`,
            defineTool({
              ...mcpTools[name],
              inputSchema: defineDurableSchema({
                closure: { name },
                schema: ({ name }) => mcpTools[name].inputSchema,
              }),
              label: { start: () => (name === 'sam_file' ? 'SAM 文件操作' : `Climber：${name}`) },
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
