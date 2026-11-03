import { expect, test } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';
import { handler } from '../../src/api';

test('desktop state is authenticated, shutdown is opt-in and refuses active work', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir),
    skills = new Skills(f.config);
  await skills.discover();
  let finish!: () => void;
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { text: 'Done', usage: { totalTokens: 1 }, toolCalls: [] };
    },
  });
  let shutdowns = 0;
  const api = handler(service, () => {
    shutdowns++;
  });
  const req = (path: string, method = 'GET') =>
    new Request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `Bearer ${f.config.token}` },
    });
  try {
    expect((await api(new Request('http://localhost/runtime'))).status).toBe(401);
    expect((await handler(service)(req('/desktop/shutdown', 'POST'))).status).toBe(404);
    const session = store.createSession();
    const pending = service.submit(session.id, 'Wait');
    for (let i = 0; i < 100 && !finish; i++) await Bun.sleep(5);
    expect((await (await api(req('/runtime'))).json()).runningSessions).toEqual([session.id]);
    const state = await (await api(req(`/session/${session.id}/state`))).json();
    expect(state.running).toBe(true);
    expect(state.run.status).toBe('running');
    expect((await api(req('/desktop/shutdown', 'POST'))).status).toBe(409);
    expect(shutdowns).toBe(0);
    finish();
    await pending;
    expect((await api(req('/desktop/shutdown', 'POST'))).status).toBe(200);
    await Bun.sleep(80);
    expect(shutdowns).toBe(1);
  } finally {
    finish?.();
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
