import { describe, expect, test } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { AgentService } from '../../src/agent';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { handler } from '../../src/api';
import type { ModelAdapter, ModelTurn, ServiceEvent } from '../../src/shared/types';
import { callVendor } from '@auto-agent/climber-mcp/contracts';
import { InstrumentViews } from '../../src/integrations/instruments';
import { mcpServerSchema } from '../../src/mcp/config';
import { join } from 'node:path';

const health = { softwareReady: true, deviceConnected: true, deviceBusy: false };
const experiment = {
  experimentId: 'EXP-1',
  analysisPort: 1,
  tubeNo: 109,
  samPath: 'E:\\templates\\sample.SAM',
  sampleName: 'Sample',
  emptyTubeMassG: 29.1,
  sampleMassG: 1.5,
};
function vendor() {
  let task: any = null,
    unavailable = false,
    uncertain = false;
  const writes: { path: string; body: any }[] = [];
  let reads = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET') {
        reads++;
        if (unavailable) return new Response('offline', { status: 503 });
        return Response.json({
          ok: true,
          data: path.endsWith('/health') ? health : { health, task },
        });
      }
      const body = await request.json();
      writes.push({ path, body });
      if (path.endsWith('/tasks'))
        task = { batchId: body.batchId, state: 'READY', experiments: body.experiments };
      else task = { ...task, state: 'RUNNING' };
      if (uncertain) return new Response('connection lost', { status: 500 });
      return Response.json({ ok: true, data: { task } });
    },
  });
  return {
    server,
    writes,
    get reads() {
      return reads;
    },
    setUnavailable() {
      unavailable = true;
    },
    setUncertain() {
      uncertain = true;
    },
  };
}
async function setup(model: ModelAdapter, url: string) {
  const f = await fixture();
  f.config.mcpServers = {
    climber: mcpServerSchema.parse({
      command: 'builtin',
      args: ['--mcp-server', 'climber'],
      env: {
        CLIMBER_SERVICE_URL: url,
        CLIMBER_TIMEOUT_MS: '1000',
        CLIMBER_STATE_DIR: join(f.dir, 'mcp-state'),
      },
      tools: {
        get_health: 'read',
        get_status: 'read',
        register_batch: 'write',
        start_batch: 'write',
      },
      outcomeContract: 'structured-v1',
      timeoutMs: 4000,
    }),
  };
  const bindings = [{ id: 'climber-01', name: 'Climber', kind: 'climber', mcpServer: 'climber' }];
  const store = new Store(f.config.dataDir),
    skills = new Skills(f.config);
  await skills.discover();
  const service = new AgentService(
    f.config,
    store,
    skills,
    new ScriptExecutor(f.config, skills),
    model,
  );
  return {
    ...f,
    store,
    service,
    views: new InstrumentViews(bindings, f.config, service.mcp, (event) =>
      service.events.publish(event),
    ),
    async close() {
      await service.shutdown();
      store.close();
      await f.cleanup();
    },
  };
}
const turn = (calls: ModelTurn['toolCalls'] = []): ModelTurn => ({
  text: calls.length ? '' : '完成',
  toolCalls: calls,
  usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
});
describe('MCP device integration', () => {
  test('instrument SSE sends bounded invalidations, deduplicates unchanged facts and never replays history', async () => {
    const v = vendor();
    const f = await setup(
      {
        async generate() {
          throw new Error('View updates must not call a model');
        },
      },
      `${v.server.url.origin}/api/v1`,
    );
    const controller = new AbortController();
    const reconnected = new AbortController();
    const notices: ServiceEvent[] = [];
    const unsubscribe = f.service.events.subscribe((event) => notices.push(event));
    try {
      const request = handler(f.service, undefined, [f.views.http]);
      const headers = { Authorization: `Bearer ${f.config.token}` };
      const response = await request(
        new Request('http://localhost/event', { headers, signal: controller.signal }),
      );
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(': connected\n\n');
      const first = await f.views.refresh('climber-01');
      const wire = new TextDecoder().decode((await reader.read()).value);
      expect(JSON.parse(wire.slice('data: '.length))).toEqual({
        type: 'extension.changed',
        properties: {
          extension: 'instruments',
          resourceId: 'climber-01',
          revision: first.revision,
        },
      });
      expect(wire).not.toContain('health');
      expect(wire).not.toContain(f.config.token);
      const same = await f.views.refresh('climber-01');
      expect(same.revision).toBe(first.revision + 1);
      expect(notices).toHaveLength(1);
      v.setUnavailable();
      const stale = await f.views.refresh('climber-01');
      expect(stale.stale).toBe(true);
      expect(notices).toHaveLength(2);
      expect(
        JSON.parse(new TextDecoder().decode((await reader.read()).value).slice('data: '.length))
          .properties.revision,
      ).toBe(stale.revision);
      controller.abort();
      expect((await reader.read()).done).toBe(true);
      const again = await request(
        new Request('http://localhost/event', { headers, signal: reconnected.signal }),
      );
      const next = again.body!.getReader();
      expect(new TextDecoder().decode((await next.read()).value)).toBe(': connected\n\n');
      const snapshot = await (
        await request(new Request('http://localhost/devices/climber-01/status', { headers }))
      ).json();
      expect(snapshot).toMatchObject({
        revision: stale.revision,
        stale: true,
        observedAt: same.observedAt,
      });
      expect(notices).toHaveLength(2);
      expect(v.reads).toBe(3);
      expect(v.writes).toHaveLength(0);
      reconnected.abort();
      expect((await next.read()).done).toBe(true);
    } finally {
      unsubscribe();
      controller.abort();
      reconnected.abort();
      await f.close();
      v.server.stop(true);
    }
  }, 20000);

  test('a notification subscriber failure cannot change a successful instrument observation', async () => {
    const v = vendor();
    const f = await setup(
      {
        async generate() {
          return turn();
        },
      },
      `${v.server.url.origin}/api/v1`,
    );
    try {
      const views = new InstrumentViews(
        [{ id: 'climber-01', name: 'Climber', kind: 'climber', mcpServer: 'climber' }],
        f.config,
        f.service.mcp,
        () => {
          throw new Error('subscriber failed');
        },
      );
      expect(await views.refresh('climber-01')).toMatchObject({
        stale: false,
        error: null,
        revision: 1,
        health: { deviceConnected: true },
      });
    } finally {
      await f.close();
      v.server.stop(true);
    }
  }, 20000);
  test('device API uses real stdio MCP without a model, coalesces reads and preserves stale facts', async () => {
    const v = vendor();
    let modelCalls = 0;
    const f = await setup(
      {
        async generate() {
          modelCalls++;
          return turn();
        },
      },
      `${v.server.url.origin}/api/v1`,
    );
    try {
      const request = handler(f.service, undefined, [f.views.http]);
      expect((await request(new Request('http://localhost/devices'))).status).toBe(401);
      const headers = { Authorization: `Bearer ${f.config.token}` };
      expect(
        (await handler(f.service)(new Request('http://localhost/devices', { headers }))).status,
      ).toBe(404);
      expect((await request(new Request('http://localhost/devices', { headers }))).status).toBe(
        200,
      );
      const snapshots = await Promise.all([
        f.views.refresh('climber-01'),
        f.views.refresh('climber-01'),
      ]);
      expect(v.reads).toBe(1);
      expect(snapshots[0]!.health.deviceConnected).toBe(true);
      expect(snapshots[0]!.taskKnown).toBe(true);
      expect(snapshots[0]!.task).toBeNull();
      v.setUnavailable();
      const failed = await f.views.refresh('climber-01');
      expect(failed.stale).toBe(true);
      expect(failed.health.deviceConnected).toBe(true);
      expect(failed.observedAt).toBe(snapshots[0]!.observedAt);
      expect(failed.error).not.toBeNull();
      expect(modelCalls).toBe(0);
    } finally {
      await f.close();
      v.server.stop(true);
    }
  }, 20000);
  test('Agent discovers MCP tools and registers then starts without loading a skill', async () => {
    const v = vendor();
    let step = 0;
    let lastTool = '';
    const f = await setup(
      {
        async generate(_messages, _signal, _onDelta, _onReasoning, tools) {
          if (step > 0) lastTool += JSON.stringify(_messages.at(-1));
          expect(tools).toHaveProperty('mcp__climber__register_batch');
          if (step++ === 0)
            return turn([
              {
                id: 'register',
                name: 'mcp__climber__register_batch',
                input: { batchId: 'B-1', experiments: [experiment] },
              },
            ]);
          if (step === 2)
            return turn([
              { id: 'start', name: 'mcp__climber__start_batch', input: { batchId: 'B-1' } },
            ]);
          return turn();
        },
      },
      `${v.server.url.origin}/api/v1`,
    );
    try {
      const session = f.store.createSession();
      await f.service.submit(session.id, '运行已确认批次');
      expect(lastTool).not.toContain('"error"');
      expect(v.writes).toHaveLength(2);
      expect(v.writes[0]!.body.experiments[0].tubeNo).toBe(37);
      expect(v.writes[1]!.body).toEqual({});
      expect(
        f.store.db.query("SELECT * FROM tool_operations WHERE status='confirmed'").all(),
      ).toHaveLength(2);
    } finally {
      await f.close();
      v.server.stop(true);
    }
  }, 20000);
  test('uncertain MCP writes persist unknown and block dependent tools and future generations', async () => {
    const v = vendor();
    v.setUncertain();
    let modelCalls = 0;
    const f = await setup(
      {
        async generate() {
          modelCalls++;
          return turn([
            {
              id: 'register',
              name: 'mcp__climber__register_batch',
              input: { batchId: 'B-unknown', experiments: [experiment] },
            },
            { id: 'start', name: 'mcp__climber__start_batch', input: { batchId: 'B-unknown' } },
          ]);
        },
      },
      `${v.server.url.origin}/api/v1`,
    );
    try {
      const session = f.store.createSession();
      await f.service.submit(session.id, '运行').catch(() => {});
      expect(v.writes).toHaveLength(1);
      expect(f.store.pendingReview(session.id)?.operations[0]?.status).toBe('unknown');
      await f.service.submit(session.id, '继续');
      expect(modelCalls).toBe(1);
      expect(
        f.store.db.query("SELECT name FROM sqlite_master WHERE name='device_claims'").get(),
      ).toBeNull();
    } finally {
      await f.close();
      v.server.stop(true);
    }
  }, 20000);
  test('vendor input validates paths and mapped tube collisions before writing', async () => {
    const v = vendor();
    try {
      await expect(
        callVendor(
          'register_batch',
          { batchId: 'B-1', experiments: [{ ...experiment, samPath: 'E:\\templates' }] },
          `${v.server.url.origin}/api/v1`,
          1000,
        ),
      ).rejects.toThrow();
      await expect(
        callVendor(
          'register_batch',
          {
            batchId: 'B-1',
            experiments: [
              experiment,
              { ...experiment, experimentId: 'EXP-2', analysisPort: 2, tubeNo: 181 },
            ],
          },
          `${v.server.url.origin}/api/v1`,
          1000,
        ),
      ).rejects.toThrow();
      expect(v.writes).toHaveLength(0);
    } finally {
      v.server.stop(true);
    }
  });
  test('start accepts the two documented envelopes and rejects conflicting task identities', async () => {
    let envelope: unknown = { ok: true, data: { batchId: 'B-1', state: 'STARTING' } };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json(envelope),
    });
    try {
      const call = () =>
        callVendor('start_batch', { batchId: 'B-1' }, `${server.url.origin}/api/v1`, 1000);
      expect((await call()).task?.state).toBe('STARTING');
      envelope = { ok: true, data: { task: { batchId: 'B-1', state: 'RUNNING' } } };
      expect((await call()).task?.state).toBe('RUNNING');
      envelope = {
        ok: true,
        data: { batchId: 'OTHER', task: { batchId: 'B-1', state: 'RUNNING' } },
      };
      await expect(call()).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', outcome: 'unknown' });
    } finally {
      server.stop(true);
    }
  });
});
