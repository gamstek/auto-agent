import { expect, test } from 'bun:test';
import { fixture } from '../helpers';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { Store } from '../../src/storage';
import { AgentService } from '../../src/agent';
import { readFile } from 'node:fs/promises';
import { handler } from '../../src/api';

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
  let reconciled = false;
  const service = new AgentService(config, store, skills, new ScriptExecutor(config, skills), {
    async generate() {
      if (reconciled) {
        steps++;
        return { text: '诊断后的新对话', usage: { totalTokens: 1 }, toolCalls: [] };
      }
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
                      samPath: 'E:\\templates\\template.SAM',
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
    const sessionId = store.createSession().id;
    await expect(service.submit(sessionId, '运行已授权的左侧批次')).rejects.toThrow(
      'Manual reconciliation',
    );
    expect(requests).toEqual(['/api/v1/tasks']);
    expect(store.db.query('SELECT status FROM executions').all()).toEqual([{ status: 'unknown' }]);
    expect(store.db.query('SELECT status FROM runs').all()).toEqual([
      { status: 'waiting_for_operator' },
    ]);
    expect(steps).toBe(2);
    const review = service.review(sessionId);
    expect(review.pending).not.toBeNull();
    const execution = review.pending!.executions[0]!;
    expect(execution.diagnostic).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      batchId: 'BATCH-001',
      stage: 'register',
      status: 200,
    });
    expect((execution.diagnostic!.diagnostic as any).reason).toBe('task_identity');
    const reply = await service.submit(sessionId, '看下哪里报错了');
    expect(reply.content).toContain('OUTCOME_UNKNOWN');
    expect(reply.content).toContain('BATCH-001');
    expect(reply.content).toContain('/resolve');
    expect(steps).toBe(2);
    expect(requests).toEqual(['/api/v1/tasks']);
    const agentLog = await readFile(review.logs.agent, 'utf8');
    const skillLog = await readFile(review.logs.skills, 'utf8');
    const records = skillLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      records.some(
        (entry) =>
          entry.event === 'http.response' &&
          entry.executionId === execution.id &&
          entry.runId === review.pending!.id,
      ),
    ).toBe(true);
    expect(
      records.some(
        (entry) => entry.event === 'script.diagnostic' && entry.code === 'OUTCOME_UNKNOWN',
      ),
    ).toBe(true);
    expect(agentLog).toContain('generation.failed');
    for (const secret of [config.apiKey, config.token])
      expect(agentLog + skillLog).not.toContain(secret!);
    expect(skillLog).not.toContain('sampleMassG');
    expect(skillLog).not.toContain('E:\\templates\\template.SAM');
    const api = handler(service);
    const base = `http://localhost/session/${sessionId}`;
    expect((await api(new Request(`${base}/review`))).status).toBe(401);
    const headers = { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' };
    expect((await (await api(new Request(`${base}/review`, { headers }))).json()).pending.id).toBe(
      review.pending!.id,
    );
    expect(
      (
        await api(
          new Request(`${base}/resolve_review`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ runId: 'wrong', note: '已核对' }),
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api(
          new Request(`${base}/resolve_review`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ runId: review.pending!.id, note: '' }),
          }),
        )
      ).status,
    ).toBe(400);
    expect(store.pendingReview(sessionId)?.id).toBe(review.pending!.id);
    const resolved = await api(
      new Request(`${base}/resolve_review`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          runId: review.pending!.id,
          note: '测试操作者已核对外部状态；确认不重放旧请求',
        }),
      }),
    );
    expect(resolved.status).toBe(200);
    expect(store.pendingReview(sessionId)).toBeNull();
    expect(store.db.query('SELECT status FROM executions').all()).toEqual([{ status: 'unknown' }]);
    expect(store.db.query('SELECT COUNT(*) AS count FROM run_reviews').get()).toEqual({ count: 1 });
    reconciled = true;
    expect((await service.submit(sessionId, '继续咨询')).content).toBe('诊断后的新对话');
    expect(steps).toBe(3);
    expect(requests).toEqual(['/api/v1/tasks']);
  } finally {
    await service.shutdown();
    store.close();
    server.stop(true);
    await f.cleanup();
  }
}, 30000);
