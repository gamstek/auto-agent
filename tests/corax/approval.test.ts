import { expect, test } from 'bun:test';
import { always, type ApprovalContext } from '@coraxjs/core/tools/approval';
import nativeBash from '@coraxjs/core/tools/bash';
import nativeWriteFile from '@coraxjs/core/tools/write_file';
import bash from '../../corax/tools/bash';
import writeFile from '../../corax/tools/write_file';
import {
  climberApproval as decideClimber,
  requestApproval,
  setApprovalSetting,
  approvalSetting,
} from '../../corax/lib/approval';
import approvalChannel from '../../corax/channels/approval';

const context = (id = 'fixture') =>
  ({
    session: { id },
    toolName: 'bash',
    approvedTools: new Set<string>(),
  }) as unknown as ApprovalContext;
const climberApproval = (tool: Parameters<typeof decideClimber>[0], input: unknown) =>
  decideClimber(tool, input, context());

test('host approvals retain the original Corax schemas and executors', () => {
  expect(bash.execute).toBe(nativeBash.execute);
  expect(bash.inputSchema).toBe(nativeBash.inputSchema);
  expect(writeFile.execute).toBe(nativeWriteFile.execute);
  expect(writeFile.inputSchema).toBe(nativeWriteFile.inputSchema);
  for (const tool of [bash, writeFile]) {
    expect(typeof tool.approval).toBe('object');
    const request = typeof tool.approval === 'object' ? tool.approval.request : always();
    expect(request(context() as never)).toBe('user-approval');
  }
});

test('global policy uses native helpers across sessions while once grants remain session-owned', () => {
  const id = `policy-${crypto.randomUUID()}`;
  const current = context(id);
  expect(requestApproval(current)).toBe('user-approval');
  const revision = approvalSetting().revision;
  expect(setApprovalSetting('never', revision).mode).toBe('never');
  expect(requestApproval(current)).toBe('not-applicable');
  expect(requestApproval(context('different'))).toBe('not-applicable');
  expect(decideClimber('register_batch', {}, current)).toBe('not-applicable');
  expect(decideClimber('start_batch', {}, current)).toBe('not-applicable');
  setApprovalSetting('once', revision + 1);
  expect(requestApproval(current)).toBe('user-approval');
  const granted = { ...current, approvedTools: new Set(['bash']) };
  expect(requestApproval(granted)).toBe('not-applicable');
  expect(requestApproval(context('different'))).toBe('user-approval');
  setApprovalSetting('always', revision + 2);
  expect(requestApproval(granted)).toBe('user-approval');
  expect(() => setApprovalSetting('never', revision)).toThrow('已经变化');
  expect(approvalSetting().mode).toBe('always');
});

test('Climber and SAM approvals distinguish read-only contracts from every write operation', () => {
  expect(climberApproval('get_health', {})).toBe('not-applicable');
  expect(climberApproval('get_status', {})).toBe('not-applicable');
  for (const operation of ['profiles', 'inspect', 'compare'])
    expect(climberApproval('sam_file', { operation, input: {} })).toBe('not-applicable');
  for (const operation of ['create', 'modify', 'save-as'])
    expect(climberApproval('sam_file', { operation, input: {} })).toBe('user-approval');
  expect(climberApproval('sam_file', { operation: 'unknown', input: {} })).toBe('user-approval');
  expect(climberApproval('sam_file', undefined)).toBe('user-approval');
  expect(climberApproval('register_batch', {})).toBe('user-approval');
  expect(climberApproval('start_batch', {})).toBe('user-approval');
});

test('global strategy endpoint never asks for session context or history and rejects per-session payloads', async () => {
  const previous = process.env.AUTO_AGENT_TOKEN;
  process.env.AUTO_AGENT_TOKEN = 'approval-fixture-token';
  try {
    const route = approvalChannel.routes.find((route) => route.method === 'POST');
    if (!route || route.transport === 'websocket') throw new Error('Missing policy route');
    const headers = {
      authorization: `Basic ${Buffer.from('auto-agent:approval-fixture-token').toString('base64')}`,
      'content-type': 'application/json',
    };
    const noSessionContext = new Proxy(
      {},
      {
        get() {
          throw new Error('Policy updates must not read a session');
        },
      },
    );
    const value = approvalSetting();
    const response = await route.handler(
      new Request('http://localhost/desktop/approval', {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'never', revision: value.revision }),
      }),
      noSessionContext as never,
    );
    expect(response.status).toBe(200);
    expect(approvalSetting().mode).toBe('never');
    const perSession = await route.handler(
      new Request('http://localhost/desktop/approval', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          mode: 'always',
          revision: approvalSetting().revision,
          sessionId: 'old-scope',
        }),
      }),
      noSessionContext as never,
    );
    expect(perSession.status).toBe(400);
    const unauthenticated = await route.handler(
      new Request('http://localhost/desktop/approval', { method: 'POST', body: '{}' }),
      noSessionContext as never,
    );
    expect(unauthenticated.status).toBe(401);
  } finally {
    setApprovalSetting('always', approvalSetting().revision);
    if (previous === undefined) delete process.env.AUTO_AGENT_TOKEN;
    else process.env.AUTO_AGENT_TOKEN = previous;
  }
});
