import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, generateText, streamText, wrapLanguageModel } from 'ai';
import { modelErrorMiddleware } from '../../corax/lib/model';

for (const status of [401, 403, 400]) {
  test(`model error reporting follows HTTP ${status}, not a provider name or a missing key`, async () => {
    const provider = createOpenAICompatible({
      name: 'private-fixture',
      baseURL: 'http://127.0.0.1/private/v1',
      fetch: (async (_url, init) => {
        assert.equal(new Headers(init?.headers).get('authorization'), null);
        return Response.json(
          { error: { message: 'fixture failure', type: 'fixture' } },
          { status },
        );
      }) as typeof fetch,
    });
    const model = wrapLanguageModel({
      model: provider.chatModel('arbitrary-private-model'),
      middleware: modelErrorMiddleware,
    });
    await assert.rejects(
      generateText({ model, prompt: 'local fixture', maxRetries: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(APICallError.isInstance(error));
        assert.equal(error.statusCode, status);
        assert.match(
          error.message,
          status === 400 ? /fixture failure/ : new RegExp(`HTTP ${status}`),
        );
        return true;
      },
    );
    const result = streamText({ model, prompt: 'local fixture', maxRetries: 0, onError() {} });
    const errors: unknown[] = [];
    for await (const part of result.fullStream) if (part.type === 'error') errors.push(part.error);
    assert.equal(errors.length, 1);
    assert.ok(APICallError.isInstance(errors[0]));
    assert.equal(errors[0].statusCode, status);
    assert.match(
      errors[0].message,
      status === 400 ? /fixture failure/ : new RegExp(`HTTP ${status}`),
    );
  });
}
