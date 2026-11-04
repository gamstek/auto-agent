import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { Ajv, type ValidateFunction } from 'ajv';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { Config } from '../config';
import { AppError } from '../shared/types';
import { waitFor } from '../shared/abort';
import { mcpEnvironmentSecrets, type McpServerConfig } from './config';
import { runtimeCommand } from '../execution/runtime';
import { version } from '../../package.json';

export type McpDefinition = {
  name: string;
  serverId: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  access: 'read' | 'write';
  fingerprint: string;
};
type Connection = {
  client: Client;
  tools: McpDefinition[];
  validators: Map<string, ValidateFunction>;
};
const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class McpClients {
  private connections = new Map<string, Promise<Connection>>();
  private closed = false;
  private controller = new AbortController();
  constructor(private config: Config) {}
  secrets(): string[] {
    return mcpEnvironmentSecrets(this.config.mcpServers);
  }
  private connect(id: string): Promise<Connection> {
    if (this.closed) return Promise.reject(new AppError('shutdown', 'MCP client is closed', 503));
    const existing = this.connections.get(id);
    if (existing) return existing;
    const config = this.config.mcpServers?.[id];
    if (!config?.enabled)
      return Promise.reject(new AppError('mcp_unavailable', 'MCP server is not enabled', 503));
    const promise = this.open(id, config);
    this.connections.set(id, promise);
    void promise.catch(() => {
      if (this.connections.get(id) === promise) this.connections.delete(id);
    });
    return promise;
  }
  private async open(id: string, config: McpServerConfig): Promise<Connection> {
    const env: Record<string, string> = {};
    for (const key of [
      'PATH',
      'SystemRoot',
      'HOME',
      'USERPROFILE',
      'TEMP',
      'TMP',
      'APPDATA',
      'LOCALAPPDATA',
    ])
      if (process.env[key]) env[key] = process.env[key]!;
    let command: string, args: string[];
    if (config.command === 'builtin') {
      if (!config.args[0])
        throw new AppError('mcp_configuration', 'A builtin executable mode is required');
      [command, args] = runtimeCommand(config.args[0], config.args.slice(1));
      if (args[0] !== config.args[0]) args.unshift('--no-env-file', '--no-install');
    } else {
      command = /[\\/]/.test(config.command)
        ? resolve(dirname(this.config.configPath ?? resolve('config.json')), config.command)
        : config.command;
      args = config.args;
    }
    Object.assign(env, config.env);
    for (const [key, source] of Object.entries(config.envFrom)) {
      if (!process.env[source])
        throw new AppError(
          'mcp_credentials',
          'A configured MCP environment reference is unavailable',
        );
      env[key] = process.env[source]!;
    }
    const client = new Client({ name: 'auto-agent', version }, { capabilities: {} });
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      this.connections.delete(id);
      await client.close();
    });
    const transport = new StdioClientTransport({
      command,
      args,
      env,
      stderr: 'pipe',
      maxBufferSize: Math.min(4194304, Math.max(262144, this.config.resourceLimitBytes * 2)),
      cwd: config.cwd ?? dirname(this.config.configPath ?? resolve('config.json')),
    });
    transport.stderr?.on('data', () => {}); // Drain, never persist arbitrary server stderr.
    try {
      await client.connect(transport, {
        timeout: config.timeoutMs,
        signal: this.controller.signal,
      });
      const tools: McpDefinition[] = [];
      const validators = new Map<string, ValidateFunction>();
      const modelNames = new Set<string>();
      const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
      let cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, {
          timeout: config.timeoutMs,
          signal: this.controller.signal,
        });
        if (
          Buffer.byteLength(JSON.stringify(page)) > 262144 ||
          tools.length + page.tools.length > 64
        )
          throw new Error('catalog limit');
        for (const entry of page.tools) {
          if (this.secrets().some((secret) => JSON.stringify(entry).includes(secret)))
            throw new Error('credential in tool catalog');
          if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(entry.name)) throw new Error('tool name');
          const access = Object.hasOwn(config.tools, entry.name)
            ? config.tools[entry.name]
            : undefined;
          if (access !== 'read' && access !== 'write') continue;
          if (validators.has(entry.name)) throw new Error('duplicate tool');
          const safeName = entry.name.replace(/[^a-zA-Z0-9_]/g, '_');
          const longName = `mcp__${id.replaceAll('-', '_')}__${safeName}`;
          const name =
            longName.length <= 64 && safeName === entry.name
              ? longName
              : `${longName.slice(0, 55)}_${fingerprint([id, entry.name]).slice(0, 8)}`;
          if (modelNames.has(name)) throw new Error('tool name collision');
          modelNames.add(name);
          tools.push({
            name,
            serverId: id,
            toolName: entry.name,
            description: `${id}: ${(entry.description ?? entry.name).slice(0, 2000)}`,
            inputSchema: entry.inputSchema,
            access,
            fingerprint: fingerprint(entry),
          });
          validators.set(entry.name, ajv.compile(entry.inputSchema));
        }
        cursor = page.nextCursor;
        if (cursor) {
          if (cursors.has(cursor) || cursors.size >= 8) throw new Error('pagination limit');
          cursors.add(cursor);
        }
      } while (cursor);
      const connection = { client, tools, validators };
      client.onclose = () => {
        void this.connections
          .get(id)
          ?.then((current) => {
            if (current === connection) this.connections.delete(id);
          })
          .catch(() => {});
      };
      return connection;
    } catch {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw new AppError(
        'mcp_connection',
        `MCP server ${id} could not initialize its tool contract`,
        503,
      );
    }
  }
  async catalog(signal?: AbortSignal): Promise<McpDefinition[]> {
    const pending = Promise.all(
      Object.entries(this.config.mcpServers ?? {})
        .filter(([, c]) => c.enabled)
        .map(async ([id]) => {
          try {
            return (await this.connect(id)).tools;
          } catch {
            return [];
          }
        }),
    );
    const results = await (signal ? waitFor(pending, signal) : pending);
    return results.flat();
  }
  async definition(serverId: string, toolName: string) {
    const tool = (await this.connect(serverId)).tools.find((t) => t.toolName === toolName);
    if (!tool) throw new AppError('mcp_tool_unavailable', 'MCP capability is unavailable', 503);
    return tool;
  }
  async prepare(tool: McpDefinition, input: unknown, signal: AbortSignal) {
    const connection = await waitFor(this.connect(tool.serverId), signal);
    signal.throwIfAborted();
    if (
      connection.tools.find((t) => t.toolName === tool.toolName)?.fingerprint !== tool.fingerprint
    )
      throw new AppError(
        'mcp_contract_changed',
        'MCP tool contract changed; start a new generation',
        409,
      );
    if (Buffer.byteLength(JSON.stringify(input)) > this.config.requestLimitBytes)
      throw new AppError('mcp_input', 'MCP tool input exceeds its byte limit');
    const validator = connection.validators.get(tool.toolName);
    if (!validator?.(input))
      throw new AppError(
        'mcp_input',
        `MCP tool input does not match its schema (${validator?.errors?.[0]?.keyword ?? 'unknown'})`,
      );
    return async (metadata?: Record<string, string>) => {
      const result = await connection.client.callTool(
        {
          name: tool.toolName,
          arguments: input as Record<string, unknown>,
          ...(metadata ? { _meta: metadata } : {}),
        },
        undefined,
        { signal, timeout: this.config.mcpServers![tool.serverId]!.timeoutMs + 1000 },
      );
      if (Buffer.byteLength(JSON.stringify(result)) > this.config.resourceLimitBytes)
        throw new AppError('mcp_output_limit', 'MCP tool output exceeds the configured limit');
      return result;
    };
  }
  async close() {
    this.closed = true;
    this.controller.abort();
    await Promise.allSettled(
      [...this.connections.values()].map(async (pending) => (await pending).client.close()),
    );
    this.connections.clear();
  }
}
