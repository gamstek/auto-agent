import { createHash } from 'node:crypto';
import type { Config } from '../config';
import type { Store } from '../storage';
import { AppError } from '../shared/types';
import { waitFor } from '../shared/abort';
import { UncertainToolError, type ToolContext, type ToolResult } from '../tool/context';
import { McpClients, type McpDefinition } from './client';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

/** Protocol execution and generic auditing only. No skill, vendor or device knowledge. */
export class McpService {
  readonly clients: McpClients;
  private controller = new AbortController();
  private reads = new Map<string, Promise<unknown>>();
  constructor(
    private config: Config,
    private audit: Pick<Store, 'beginToolOperation' | 'finishToolOperation' | 'runSessionId'>,
  ) {
    this.clients = new McpClients(config);
  }
  catalog(signal?: AbortSignal) {
    return this.clients.catalog(signal);
  }
  secrets() {
    return this.clients.secrets();
  }
  async read(serverId: string, toolName: string, input: unknown = {}) {
    const definition = await this.clients.definition(serverId, toolName);
    if (definition.access !== 'read')
      throw new AppError(
        'mcp_read_only',
        'This endpoint permits only host-configured read tools',
        403,
      );
    return this.readDefinition(definition, input, this.controller.signal);
  }
  private async readDefinition(definition: McpDefinition, input: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const key = JSON.stringify([
      definition.serverId,
      definition.toolName,
      definition.fingerprint,
      canonical(input),
    ]);
    const running = this.reads.get(key);
    if (running) return waitFor(running, signal);
    const pending = (async () => {
      const call = await this.clients.prepare(definition, input, this.controller.signal);
      const result = await call();
      if (result.isError) throw new AppError('mcp_tool_error', 'MCP read operation failed', 503);
      return result.structuredContent ?? result.content;
    })().finally(() => this.reads.delete(key));
    this.reads.set(key, pending);
    return waitFor(pending, signal);
  }
  async invoke(
    definition: McpDefinition,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const signal = AbortSignal.any([context.run.signal, this.controller.signal]);
    if (definition.access === 'read') {
      return {
        status: 'completed',
        effect: 'none',
        output: await this.readDefinition(definition, input, signal),
      };
    }
    const call = await this.clients.prepare(definition, input, signal);
    signal.throwIfAborted();
    const hash = createHash('sha256')
      .update(JSON.stringify(canonical(input)))
      .digest('hex');
    const server = this.config.mcpServers![definition.serverId]!;
    const resourceKey = createHash('sha256')
      .update(
        JSON.stringify(
          canonical({
            command: server.command,
            cwd: server.cwd,
            args: server.args,
            env: server.env,
            envFrom: server.envFrom,
          }),
        ),
      )
      .digest('hex');
    const operationId = this.audit.beginToolOperation(
      context.run.id,
      definition.serverId,
      definition.toolName,
      hash,
      resourceKey,
    );
    let status: 'confirmed' | 'rejected' | 'unknown' = 'unknown';
    let output: unknown;
    try {
      const response = await call({
        'auto-agent/session-id': this.audit.runSessionId(context.run.id),
        'auto-agent/operation-id': operationId,
      });
      output = response.structuredContent ?? response.content;
      if (!response.isError) status = 'confirmed';
      else if (this.config.mcpServers![definition.serverId]!.outcomeContract === 'structured-v1') {
        const failure = (response.structuredContent as Record<string, unknown> | undefined)?.error;
        if (
          failure &&
          typeof failure === 'object' &&
          'outcome' in failure &&
          failure.outcome === 'rejected'
        )
          status = 'rejected';
      }
    } catch {
      status = 'unknown';
    }
    try {
      this.audit.finishToolOperation(operationId, status);
    } catch {
      throw new UncertainToolError(
        'MCP result could not be persisted; operator review required',
        { operationId },
        { status: 'failed', effect: 'unknown', output: { response: output ?? null, operationId } },
      );
    }
    context.diagnostics?.write('agent', 'mcp.operation', {
      operationId,
      runId: context.run.id,
      serverId: definition.serverId,
      toolName: definition.toolName,
      status,
    });
    if (status === 'unknown')
      throw new UncertainToolError(
        'MCP write outcome is unknown; preserve its operation ID and reconcile before continuing.',
        { operationId },
        { status: 'failed', effect: 'unknown', output: { response: output ?? null, operationId } },
      );
    return {
      status: status === 'confirmed' ? 'completed' : 'failed',
      effect: status === 'confirmed' ? 'acknowledged' : 'none',
      output,
    };
  }
  async close() {
    this.controller.abort();
    await this.clients.close();
  }
}
