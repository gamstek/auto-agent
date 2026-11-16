import { expect, test } from 'bun:test';
import { configSchema } from 'auto-agent/config';
import { SessionTitleService, sessionTitleInput } from '../../corax/lib/session-title';

const config = configSchema.parse({ model: 'local' });

test('topic titles use bounded user content and the configured anonymous-compatible model', async () => {
  let observed = '';
  const service = new SessionTitleService(async (settings, content, signal) => {
    expect(settings.model).toBe('local');
    expect(signal.aborted).toBe(false);
    observed = content;
    return JSON.stringify({ title: '多孔碳材料测试方案' });
  });
  expect(await service.generate(config, '材料'.repeat(4000))).toEqual({
    title: '多孔碳材料测试方案',
  });
  expect(Array.from(observed)).toHaveLength(2000);
  expect(sessionTitleInput.safeParse({ content: '提问', command: 'run' }).success).toBe(false);
});

test('invalid, oversized or failed generations preserve the derived title without retry', async () => {
  for (const text of [
    'not JSON',
    '{"title":""}',
    JSON.stringify({ title: '长'.repeat(33) }),
    JSON.stringify({ title: '多行\n标题' }),
    '{"title":"主题","extra":1}',
  ]) {
    let calls = 0;
    const service = new SessionTitleService(async () => {
      calls++;
      return text;
    });
    expect(await service.generate(config, '提问')).toEqual({ title: null });
    expect(calls).toBe(1);
  }
  const service = new SessionTitleService(async () => {
    throw new Error('401');
  });
  expect(await service.generate(config, '提问')).toEqual({ title: null });
});

test('cancelled and over-budget requests do not call a model', async () => {
  let calls = 0;
  const service = new SessionTitleService(async () => {
    calls++;
    return '{"title":"主题"}';
  });
  expect(await service.generate(config, '提问', AbortSignal.abort())).toEqual({ title: null });
  expect(await service.generate({ ...config, maxInputTokens: 1024 }, '提问')).toEqual({
    title: null,
  });
  expect(calls).toBe(0);
});
