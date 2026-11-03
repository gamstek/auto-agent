import { expect, test } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { loadSessionHistory } from '../../src/agent/history';

test('older history is summarized as a contiguous persisted prefix and reused after restart', async () => {
  const f = await fixture();
  let store = new Store(f.config.dataDir);
  try {
    const session = store.createSession();
    for (let i = 0; i < 14; i++)
      store.addMessage(
        session.id,
        i % 2 ? 'assistant' : 'user',
        `entry-${i} CONFIRMED_1.25g ${'history '.repeat(70)}`,
      );
    store.addMessage(session.id, 'user', 'CURRENT_REQUEST');
    let calls = 0;
    const model = {
      async generate() {
        throw new Error('No main model');
      },
      async summarize(messages: any) {
        calls++;
        expect(JSON.stringify(messages)).toContain('CONFIRMED_1.25g');
        return {
          text: 'Prior confirmed sample mass CONFIRMED_1.25g; original operation remains unresolved.',
          usage: { totalTokens: 10 },
        };
      },
    };
    const options = {
      store,
      sessionId: session.id,
      maxInputTokens: 4000,
      toolTokens: 0,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      model,
      redact: (text: string) => text,
    };
    const messages = await loadSessionHistory(options);
    expect(calls).toBeGreaterThan(0);
    expect(JSON.stringify(messages)).toContain('CURRENT_REQUEST');
    expect(messages[0]!.role).toBe('user');
    expect(String(messages[0]!.content)).toContain('untrusted data');
    const saved = store.contextSummary(session.id);
    expect(saved.throughRow).toBeGreaterThan(0);
    expect(store.messages(session.id)).toHaveLength(15);
    store.close();
    store = new Store(f.config.dataDir);
    const previousCalls = calls;
    expect(await loadSessionHistory({ ...options, store })).toEqual(messages);
    expect(calls).toBe(previousCalls);
    expect(store.contextSummary(session.id)).toEqual(saved);
  } finally {
    store.close();
    await f.cleanup();
  }
});

test('failed, invalid and timed-out history summarization never advances the persisted cursor', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  try {
    const session = store.createSession();
    for (let i = 0; i < 10; i++) store.addMessage(session.id, 'user', 'old '.repeat(200));
    store.addMessage(session.id, 'user', 'Current');
    const options = {
      store,
      sessionId: session.id,
      maxInputTokens: 4000,
      toolTokens: 0,
      timeoutMs: 20,
      signal: new AbortController().signal,
      redact: (text: string) => text,
    };
    for (const summarize of [
      async () => {
        throw new Error('provider failed');
      },
      async () => ({ text: '', usage: { totalTokens: 1 } }),
      async () => ({ text: 'x'.repeat(10000), usage: { totalTokens: 1 } }),
      () => new Promise<never>(() => {}),
    ]) {
      await expect(
        loadSessionHistory({
          ...options,
          model: {
            async generate() {
              throw new Error('No main model');
            },
            summarize,
          },
        }),
      ).rejects.toThrow();
      expect(store.contextSummary(session.id)).toEqual({ throughRow: 0, summary: '' });
      expect(store.messages(session.id)).toHaveLength(11);
    }
  } finally {
    store.close();
    await f.cleanup();
  }
});
