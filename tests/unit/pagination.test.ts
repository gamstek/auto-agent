import { expect, test } from 'bun:test';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { SQLiteSaver } from '../../src/storage/checkpointer';
import { handler } from '../../src/api';
import { AgentService } from '../../src/agent';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { version } from '../../package.json';

test('bounded history, stable pagination and health version', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      return { text: 'answer', toolCalls: [], usage: { totalTokens: 1 } };
    },
  });
  try {
    // Batch fixture writes; pagination is not a per-commit disk durability benchmark.
    const { sessions, session, messages } = store.db.transaction(() => {
      const sessions = Array.from({ length: 105 }, () => store.createSession());
      store.db.query('UPDATE sessions SET updatedAt = 1').run();
      const session = sessions[0];
      const messages = Array.from({ length: 105 }, (_, i) =>
        store.addMessage(session.id, 'user', `${i}中文`),
      );
      store.db.query('UPDATE messages SET createdAt = 1').run();
      return { sessions, session, messages };
    })();
    expect(store.messages(session.id).map((m) => m.id)).toEqual(
      messages.slice(-100).map((m) => m.id),
    );
    expect(store.messages(session.id, 2, 2).map((m) => m.id)).toEqual(
      messages.slice(-4, -2).map((m) => m.id),
    );
    expect(
      store.contextMessages(session.id, Buffer.byteLength('104中文') * 2).map((m) => m.id),
    ).toEqual(messages.slice(-2).map((m) => m.id));
    expect(store.contextMessages(session.id, 1)).toEqual([]);
    expect(store.firstUserContent(session.id)).toBe('0中文');
    expect(store.listSessions()).toHaveLength(100);
    expect(store.listSessions(2, 1).map((s) => s.id)).toEqual([sessions[104].id, sessions[103].id]);
    const request = (path: string) =>
      handler(service)(
        new Request(`http://localhost${path}`, {
          headers: { Authorization: 'Bearer ' + f.config.token },
        }),
      );
    expect(await (await request('/global/health')).json()).toEqual({ healthy: true, version });
    expect(await (await request(`/session/${session.id}/message?limit=2&offset=2`)).json()).toEqual(
      store.messages(session.id, 2, 2),
    );
    expect(await (await request('/session?limit=2&offset=1')).json()).toEqual(
      store.listSessions(2, 1),
    );
    for (const query of [
      'limit=0',
      'limit=1001',
      'limit=1.5',
      'offset=-1',
      'limit=',
      'offset=9007199254740992',
    ]) {
      expect((await request(`/session?${query}`)).status).toBe(400);
      expect((await request(`/session/${session.id}/message?${query}`)).status).toBe(400);
    }
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});

test('checkpoint limits preserve metadata filtering and iterate lazily', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  try {
    const saver = new SQLiteSaver(store.db);
    const config = { configurable: { thread_id: 'thread', checkpoint_ns: '' } };
    for (let i = 0; i < 12; i++) {
      await saver.put(
        config,
        { ...emptyCheckpoint(), id: String(i).padStart(3, '0') },
        { source: 'loop', step: i % 2, parents: {} },
        {},
      );
    }
    const ids = async (options: Parameters<typeof saver.list>[1]) => {
      const result: string[] = [];
      for await (const tuple of saver.list(config, options)) result.push(tuple.checkpoint.id);
      return result;
    };
    expect(await ids({ limit: 0 })).toEqual([]);
    expect(await ids({ limit: 2 })).toEqual(['011', '010']);
    expect(await ids({ limit: 2, filter: { step: 0 } })).toEqual(['010', '008']);
    expect(await ids({ limit: 2, before: { configurable: { checkpoint_id: '008' } } })).toEqual([
      '007',
      '006',
    ]);
    expect(await ids({ filter: { step: 9 }, limit: 1 })).toEqual([]);
    await expect(ids({ limit: -1 })).rejects.toThrow();
    // Invalid older payloads must not be read once the requested limit is satisfied.
    store.db
      .query(
        "UPDATE checkpoints SET checkpointType = 'invalid', checkpoint = X'00' WHERE id < '008'",
      )
      .run();
    expect(await ids({ limit: 2 })).toEqual(['011', '010']);
    expect(await ids({ limit: 2, filter: { step: 0 } })).toEqual(['010', '008']);
  } finally {
    store.close();
    await f.cleanup();
  }
});
