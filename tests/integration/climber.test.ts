import { expect, test } from 'bun:test';
import { fixture } from '../helpers';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { Store } from '../../src/storage';
import { AgentService } from '../../src/agent';

test('uncertain manufacturer registration is audited as unknown and blocks dependent start', async () => {
  const f = await fixture();
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      requests.push(new URL(request.url).pathname);
      await request.json();
      return Response.json({
        ok: true,
        data: { task: { batchId: 'WRONG-BATCH', state: 'READY' } },
      });
    },
  });
  const config = {
    ...f.config,
    skillRoots: [],
    builtinSkills: true,
    resourceLimitBytes: 65536,
    outputLimitBytes: 65536,
    maxInputTokens: 64000,
    scriptEnv: { CLIMBER_SERVICE_URL: `${server.url.origin}/api/v1`, CLIMBER_TIMEOUT_MS: '5000' },
  };
  const skills = new Skills(config);
  await skills.discover();
  const store = new Store(config.dataDir);
  let steps = 0;
  const service = new AgentService(config, store, skills, new ScriptExecutor(config, skills), {
    async generate() {
      if (steps++ === 0)
        return {
          text: '',
          usage: { totalTokens: 1 },
          toolCalls: [
            {
              id: 'load',
              name: 'skill',
              input: { name: 'device-automation' },
            },
          ],
        };
      if (steps !== 2) throw new Error('No dependent model step may run after an uncertain write');
      return {
        text: '',
        usage: { totalTokens: 1 },
        toolCalls: [
          {
            id: 'register',
            name: 'execute_script',
            input: {
              skill: 'device-automation',
              path: 'scripts/climber.js',
              args: [
                'register',
                JSON.stringify({
                  batchId: 'BATCH-001',
                  experiments: [
                    {
                      experimentId: 'EXP-001',
                      analysisPort: 1,
                      tubeNo: 109,
                      samPath: '//server/share/template.SAM',
                      sampleName: '样品A',
                      emptyTubeMassG: 29.1,
                      sampleMassG: 1.5,
                    },
                  ],
                }),
              ],
            },
          },
          {
            id: 'start',
            name: 'execute_script',
            input: {
              skill: 'device-automation',
              path: 'scripts/climber.js',
              args: ['start', '{"batchId":"BATCH-001"}'],
            },
          },
        ],
      };
    },
  });
  try {
    await expect(service.submit(store.createSession().id, '运行已授权的左侧批次')).rejects.toThrow(
      'Manual reconciliation',
    );
    expect(requests).toEqual(['/api/v1/tasks']);
    expect(store.db.query('SELECT status FROM executions').all()).toEqual([{ status: 'unknown' }]);
    expect(store.db.query('SELECT status FROM runs').all()).toEqual([
      { status: 'waiting_for_operator' },
    ]);
    expect(steps).toBe(2);
  } finally {
    await service.shutdown();
    store.close();
    server.stop(true);
    await f.cleanup();
  }
}, 30000);
