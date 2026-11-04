import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'test-mcp', version: '1.0.0' });
server.registerTool('working_directory', { inputSchema: z.object({}).strict() }, async () => ({
  content: [{ type: 'text', text: process.cwd() }],
  structuredContent: { cwd: process.cwd() },
}));
server.registerTool('read-command', { inputSchema: z.object({}).strict() }, async () => ({
  content: [{ type: 'text', text: 'read-only fixture' }],
  structuredContent: { ok: true },
}));
server.registerTool(
  'echo',
  { inputSchema: z.object({ text: z.string() }).strict(), annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: 'text', text }], structuredContent: { text } }),
);
server.registerTool(
  'hidden',
  { inputSchema: z.object({}), annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: 'should not be enabled' }] }),
);
server.registerTool(
  'write_error',
  { inputSchema: z.object({}), annotations: { readOnlyHint: false } },
  async () => ({ isError: true, content: [{ type: 'text', text: 'unknown remote effect' }] }),
);
if (process.argv.includes('--delay-initialize')) await Bun.sleep(30000);
await server.connect(new StdioServerTransport());
