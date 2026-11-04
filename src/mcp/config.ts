import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
export const mcpServerSchema = z
  .object({
    kind: z.literal('stdio').default('stdio'),
    enabled: z.boolean().default(true),
    command: z.string().min(1),
    cwd: z.string().min(1).max(4096).optional(),
    args: z.array(z.string()).max(64).default([]),
    env: z.record(environmentName, z.string().max(4096)).default({}),
    envFrom: z
      .record(
        environmentName,
        environmentName.refine(
          (name) => !/^(AUTO_AGENT_|BUN_|NODE_)/i.test(name),
          'Use an MCP-specific environment source, not host runtime controls',
        ),
      )
      .default({}),
    tools: z.record(z.string().min(1).max(128), z.enum(['read', 'write'])).default({}),
    outcomeContract: z.enum(['opaque', 'structured-v1']).default('opaque'),
    timeoutMs: z.number().int().min(100).max(300000).default(10000),
  })
  .strict();
export const mcpServersSchema = z
  .record(id, mcpServerSchema)
  .refine(
    (servers) => Object.keys(servers).length <= 16,
    'At most 16 MCP servers may be configured',
  )
  .default({});
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export function mcpEnvironmentSecrets(servers: Record<string, McpServerConfig> = {}): string[] {
  return Object.values(servers).flatMap((server) =>
    Object.values(server.envFrom)
      .map((name) => process.env[name])
      .filter((value): value is string => !!value),
  );
}
