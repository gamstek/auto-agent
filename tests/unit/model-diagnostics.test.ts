import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelFailure, CloudModel } from '../../src/llm';
import { ModelRequestError } from '../../src/llm/errors';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';

test('model diagnostics retain only bounded status, known cause codes and request identifiers', () => {
  const billing = modelFailure({
    name: 'AI_RetryError',
    lastError: {
      name: 'AI_APICallError',
      statusCode: 402,
      message: 'private-provider-payload',
      responseBody: 'private-provider-payload',
      responseHeaders: { 'x-request-id': 'request-402', authorization: 'private-provider-payload' },
      requestBodyValues: { messages: 'private-user-message' },
      url: 'https://private-host/?api_key=private-key',
    },
  });
  expect(billing).toBeInstanceOf(ModelRequestError);
  expect(billing.code).toBe('model_billing');
  expect((billing as ModelRequestError).diagnostic).toEqual({
    httpStatus: 402,
    errorNames: ['AI_RetryError', 'AI_APICallError'],
    requestId: 'request-402',
  });
  expect(JSON.stringify(billing)).not.toContain('private-');
  for (const [code, expected] of [
    ['ENOTFOUND', 'model_dns'],
    ['ECONNRESET', 'model_network'],
    ['CERT_HAS_EXPIRED', 'model_tls'],
  ]) {
    const error = modelFailure({
      name: 'TypeError',
      cause: { code, message: 'private-network-message' },
    });
    expect(error.code).toBe(expected);
    expect(JSON.stringify(error)).not.toContain('private-network-message');
  }
  expect(modelFailure({ name: 'AI_JSONParseError', text: 'private-response' }).code).toBe(
    'model_response',
  );
  const cyclic: any = { name: 'Error' };
  cyclic.cause = cyclic;
  expect((modelFailure(cyclic) as ModelRequestError).diagnostic.errorNames).toEqual(['Error']);
});

test('HTTP 402 is logged with correlation and safe diagnostics without tool execution or automatic retry', async () => {
  const f = await fixture();
  let requests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      requests++;
      return Response.json(
        { error: { message: 'Insufficient Balance private-provider-payload' } },
        {
          status: 402,
          headers: { 'x-request-id': 'local-billing-check' },
        },
      );
    },
  });
  const config = { ...f.config, baseURL: `${server.url.origin}/v1` };
  const store = new Store(config.dataDir),
    skills = new Skills(config);
  await skills.discover();
  const service = new AgentService(
    config,
    store,
    skills,
    new ScriptExecutor(config, skills),
    new CloudModel(config),
  );
  try {
    await expect(service.submit(store.createSession().id, 'private-user-message')).rejects.toThrow(
      'HTTP 402',
    );
    expect(requests).toBe(1);
    expect(store.db.query('SELECT count(*) AS count FROM executions').get()).toEqual({ count: 0 });
    const log = await readFile(join(config.dataDir, 'logs/agent.jsonl'), 'utf8');
    const diagnostic = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((item) => item.event === 'model.diagnostic');
    expect(diagnostic).toMatchObject({
      code: 'model_billing',
      httpStatus: 402,
      requestId: 'local-billing-check',
      step: 1,
    });
    expect(diagnostic.runId).toBeString();
    for (const secret of [
      'private-provider-payload',
      'private-user-message',
      config.apiKey!,
      config.token,
    ])
      expect(log).not.toContain(secret);
  } finally {
    await service.shutdown();
    store.close();
    server.stop(true);
    await f.cleanup();
  }
});
