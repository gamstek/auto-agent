import { test, expect } from 'bun:test';
import { fixture } from '../helpers';
import { ensureDefaultConfig } from '../../src/config';
import { modelFailure } from '../../src/llm';
import { writeFile } from 'node:fs/promises';
test('default config generation is idempotent and never overwrites edits or saves credentials', async () => {
  const f = await fixture();
  try {
    const first = await ensureDefaultConfig(f.dir);
    expect(first.created).toBe(true);
    const text = await Bun.file(first.path).text();
    expect(JSON.parse(text).model).toBe('deepseek-flash');
    expect(JSON.parse(text).baseURL).toBe('https://api.deepseek.com');
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('token');
    await writeFile(first.path, '{"model":"custom"}');
    expect((await ensureDefaultConfig(f.dir)).created).toBe(false);
    expect(await Bun.file(first.path).text()).toBe('{"model":"custom"}');
  } finally {
    await f.cleanup();
  }
});
test('provider failures offer actionable hints without raw response data', () => {
  for (const [status, expected] of [
    [400, 'request parameters'],
    [422, 'request parameters'],
    [401, 'authentication'],
    [404, 'model or endpoint'],
    [429, 'rate limit'],
    [500, 'unavailable'],
  ] as const) {
    const error = modelFailure({ statusCode: status, responseBody: 'private-secret' });
    expect(error.message).toContain(expected);
    expect(error.message).not.toContain('private-secret');
  }
  const schemaError = modelFailure(
    Object.assign(new Error('Invalid schema for function wiki: private-secret'), {
      statusCode: 400,
    }),
  );
  expect(schemaError.code).toBe('model_tool_schema');
  expect(schemaError.message).toContain('HTTP 400');
  expect(schemaError.message).not.toContain('private-secret');
});
