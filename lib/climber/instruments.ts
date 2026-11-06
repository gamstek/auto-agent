import type { InstrumentSnapshot } from '@auto-agent/desktop-protocol';
import { resultSchema } from '@auto-agent/climber-mcp/contracts';
import { getRuntimeConfig } from '../config';
import { callClimber } from './index';

function initial(): InstrumentSnapshot {
  return {
    deviceId: 'climber',
    name: 'Climber',
    source: 'climber-mcp',
    transport: getRuntimeConfig().climber.enabled ? 'disconnected' : 'disabled',
    vendorReachability: 'unknown',
    health: { softwareReady: null, deviceConnected: null, deviceBusy: null },
    task: null,
    taskKnown: false,
    observedAt: null,
    revision: 0,
    stale: true,
    error: null,
  };
}

// An ephemeral presentation snapshot, never a replacement for manufacturer or MCP state.
let last: InstrumentSnapshot | undefined;
export function instruments(): InstrumentSnapshot[] {
  return [last ?? initial()];
}

export async function refreshClimber(signal?: AbortSignal): Promise<InstrumentSnapshot> {
  const config = getRuntimeConfig();
  if (!config.climber.enabled) return initial();
  const result = await callClimber(
    config,
    'get_status',
    {},
    {
      sessionId: 'desktop-read-only',
      callId: crypto.randomUUID(),
      signal,
    },
  );
  const previous = last ?? initial();
  const value = resultSchema.safeParse(result);
  if (value.success) {
    const { health, task } = value.data;
    last = {
      ...previous,
      transport: 'connected',
      vendorReachability: 'reachable',
      health: {
        softwareReady: health?.softwareReady ?? null,
        deviceConnected: health?.deviceConnected ?? null,
        deviceBusy: health?.deviceBusy ?? null,
        ...(health?.simulation !== undefined ? { simulation: health.simulation } : {}),
      },
      task: task ?? null,
      taskKnown: task !== undefined,
      observedAt: Date.now(),
      revision: previous.revision + 1,
      stale: false,
      error: null,
    };
  } else {
    const error = result.error ?? { code: 'INVALID_RESPONSE', message: '未取得有效的厂家状态。' };
    const disconnected = ['MCP_UNAVAILABLE', 'TIMEOUT', 'CANCELLED', 'INVALID_RESPONSE'].includes(
      error.code,
    );
    last = {
      ...previous,
      transport: disconnected ? 'disconnected' : 'connected',
      vendorReachability: 'unknown',
      stale: true,
      revision: previous.revision + 1,
      error: { code: error.code, message: error.message },
    };
  }
  return last;
}
