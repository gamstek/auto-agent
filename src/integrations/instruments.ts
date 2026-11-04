import type { Config } from '../config';
import type { HttpExtension } from '../api';
import type { McpService } from '../mcp/service';
import { AppError, type ExtensionEvent } from '../shared/types';
import { resultSchema, type ClimberResult } from '@auto-agent/climber-mcp/contracts';
import type { InstrumentView } from './config';

type Snapshot = {
  deviceId: string;
  name: string;
  kind: string;
  source: string;
  transport: 'connected' | 'disconnected' | 'disabled';
  vendorReachability: 'reachable' | 'unreachable' | 'unknown';
  health: {
    softwareReady: boolean | null;
    deviceConnected: boolean | null;
    deviceBusy: boolean | null;
    simulation?: boolean;
  };
  task: ClimberResult['task'];
  taskKnown: boolean;
  observedAt: number | null;
  lastAttemptAt: number | null;
  stale: boolean;
  revision: number;
  error: { code: string; message: string } | null;
};
/** Read-only application view adapter. Never participates in Agent tool execution. */
export class InstrumentViews {
  private snapshots = new Map<string, Snapshot>();
  private pending = new Map<string, Promise<Snapshot>>();
  constructor(
    private bindings: InstrumentView[],
    private config: Config,
    private mcp: Pick<McpService, 'read'>,
    private publish?: (event: ExtensionEvent) => void,
  ) {}
  private binding(id: string) {
    const binding = this.bindings.find((v) => v.id === id);
    if (!binding) throw new AppError('view_not_found', 'Instrument view is not configured', 404);
    return binding;
  }
  status(id: string): Snapshot {
    const binding = this.binding(id),
      old = this.snapshots.get(id);
    if (old) return { ...old, stale: old.stale || Date.now() - (old.observedAt ?? 0) > 10000 };
    return {
      deviceId: id,
      name: binding.name,
      kind: binding.kind,
      source: 'mcp',
      transport: this.config.mcpServers?.[binding.mcpServer]?.enabled ? 'disconnected' : 'disabled',
      vendorReachability: 'unknown',
      health: { softwareReady: null, deviceConnected: null, deviceBusy: null },
      task: null,
      taskKnown: false,
      observedAt: null,
      lastAttemptAt: null,
      stale: true,
      revision: 0,
      error: null,
    };
  }
  list() {
    return this.bindings.map((v) => this.status(v.id));
  }
  async refresh(id: string): Promise<Snapshot> {
    const binding = this.binding(id),
      running = this.pending.get(id);
    if (running) return running;
    const previous = this.status(id);
    const pending = (async () => {
      try {
        if (binding.kind !== 'climber')
          throw new AppError('view_unsupported', 'No renderer for this instrument view');
        const result = resultSchema.parse(await this.mcp.read(binding.mcpServer, 'get_status'));
        if (result.operation !== 'get_status' || !result.health || result.task === undefined)
          throw new Error('invalid status');
        this.snapshots.set(id, {
          ...this.status(id),
          source: result.source,
          transport: 'connected',
          vendorReachability: 'reachable',
          health: {
            ...result.health,
            softwareReady: result.health.softwareReady ?? null,
            deviceConnected: result.health.deviceConnected ?? null,
            deviceBusy: result.health.deviceBusy ?? null,
          },
          task: result.task,
          taskKnown: true,
          observedAt: Date.now(),
          lastAttemptAt: Date.now(),
          stale: false,
          error: null,
        });
      } catch (error) {
        const old = this.status(id);
        const connected = error instanceof AppError && error.code === 'mcp_tool_error';
        this.snapshots.set(id, {
          ...old,
          transport:
            old.transport === 'disabled' ? 'disabled' : connected ? 'connected' : 'disconnected',
          vendorReachability: connected ? 'unreachable' : 'unknown',
          lastAttemptAt: Date.now(),
          stale: true,
          error: {
            code: connected ? 'device_unavailable' : 'mcp_unavailable',
            message: connected
              ? '厂家状态暂时无法更新；显示最后已知状态'
              : 'MCP 状态无法确认；显示最后已知状态',
          },
        });
      }
      const snapshot = { ...this.status(id), revision: previous.revision + 1 };
      this.snapshots.set(id, snapshot);
      const state = (value: Snapshot) =>
        JSON.stringify([
          value.transport,
          value.vendorReachability,
          value.health,
          value.task,
          value.taskKnown,
          value.stale,
          value.error,
        ]);
      if (state(previous) !== state(snapshot)) {
        // Notifications are invalidation hints; the snapshot remains authoritative.
        try {
          this.publish?.({
            type: 'extension.changed',
            properties: { extension: 'instruments', resourceId: id, revision: snapshot.revision },
          });
        } catch {}
      }
      return snapshot;
    })().finally(() => this.pending.delete(id));
    this.pending.set(id, pending);
    return pending;
  }
  readonly http: HttpExtension = async ({ request, url, body, json }) => {
    if (request.method === 'GET' && url.pathname === '/devices') return json(this.list());
    const match = /^\/devices\/([a-z][a-z0-9-]{0,31})\/(status|refresh)$/.exec(url.pathname);
    if (!match) return;
    if (request.method === 'GET' && match[2] === 'status') return json(this.status(match[1]!));
    if (request.method === 'POST' && match[2] === 'refresh') {
      if (Object.keys(await body()).length)
        throw new AppError('view_input', 'Refresh accepts an empty object');
      return json(await this.refresh(match[1]!));
    }
  };
}
