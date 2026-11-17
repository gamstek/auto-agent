import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMonitor, monitorInput } from '../../corax/lib/climber/monitor';
import type { ClimberResult } from '@auto-agent/climber-mcp/contracts';

const input = monitorInput.parse({
  batchId: 'BATCH',
  experimentIds: ['EXP-1', 'EXP-2'],
  simulation: true,
});
const running: ClimberResult = {
  source: 'climber-vendor',
  operation: 'get_status',
  health: { deviceConnected: true, softwareReady: true, simulation: true },
  task: {
    batchId: 'BATCH',
    state: 'RUNNING',
    experiments: [{ experimentId: 'EXP-2' }, { experimentId: 'EXP-1' }],
  },
};

test('background monitoring is bounded and requires complete, distinct experiment identities', () => {
  assert.equal(input.intervalSeconds, 60);
  assert.equal(input.timeoutHours, 72);
  for (const change of [
    { experimentIds: [] },
    { experimentIds: ['EXP-1', 'EXP-1'] },
    { intervalSeconds: 0 },
    { intervalSeconds: 301 },
    { timeoutHours: 0 },
    { timeoutHours: 169 },
    { command: 'start' },
    { deviceRunIds: [{ experimentId: 'EXP-1', deviceRunId: 0 }] },
  ])
    assert.equal(monitorInput.safeParse({ ...input, ...change }).success, false);
});

test('learned manufacturer run IDs cannot disappear or change under the same batch and experiments', () => {
  const expected = { ...input, deviceRunIds: [{ experimentId: 'EXP-1', deviceRunId: 0 }] };
  for (const id of [undefined, null, '', 1, '0']) {
    const result = {
      ...running,
      task: {
        ...running.task!,
        state: 'COMPLETED',
        experiments: [{ experimentId: 'EXP-1', deviceRunId: id }, { experimentId: 'EXP-2' }],
      },
    };
    assert.equal(assessMonitor(expected, result).status, 'identity_mismatch');
  }
  assert.equal(
    assessMonitor(expected, {
      ...running,
      task: {
        ...running.task!,
        state: 'COMPLETED',
        experiments: [{ experimentId: 'EXP-1', deviceRunId: 0 }, { experimentId: 'EXP-2' }],
      },
    }).status,
    'completed',
  );
});

test('only explicit matching completion ends monitoring as completed; raw evidence is preserved', () => {
  assert.equal(assessMonitor(input, running).status, 'watching');
  const completed = { ...running, task: { ...running.task!, state: 'COMPLETED' } };
  assert.deepEqual(assessMonitor(input, completed), {
    status: 'completed',
    reason: '厂家新鲜状态明确报告同一批次 COMPLETED；不代表结果文件已核验。',
    task: completed.task,
    health: completed.health,
  });
  for (const state of ['READY', 'FAILED', 'CANCELLED', 'STOPPED', 'UNKNOWN'])
    assert.equal(
      assessMonitor(input, { ...running, task: { ...running.task!, state } }).status,
      'attention_required',
    );
  assert.equal(
    assessMonitor(input, { ...running, health: { ...running.health, deviceConnected: false } })
      .status,
    'attention_required',
  );
});

test('current-task replacement, missing identity and changed simulation never complete the original batch', () => {
  for (const change of [
    { task: null },
    { task: { ...running.task!, batchId: 'OTHER', state: 'COMPLETED' } },
    { task: { ...running.task!, experiments: undefined } },
    { task: { ...running.task!, experiments: [{ experimentId: 'EXP-1' }] } },
    {
      task: {
        ...running.task!,
        experiments: [{ experimentId: 'EXP-1' }, { experimentId: 'OTHER' }],
      },
    },
    { task: { ...running.task!, simulation: false } },
    { health: { simulation: false } },
    { health: {} },
  ])
    assert.equal(assessMonitor(input, { ...running, ...change }).status, 'identity_mismatch');
});
