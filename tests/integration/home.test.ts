import { test, expect } from 'bun:test';
import { fixture } from '../helpers';
import { Store } from '../../src/storage';
import { Skills } from '../../src/skills';
import { ScriptExecutor } from '../../src/execution';
import { AgentService } from '../../src/agent';
import { handler } from '../../src/api';
test('public minimal homepage and integration guide expose no local secrets and retain API auth', async () => {
  const f = await fixture();
  const store = new Store(f.config.dataDir);
  const skills = new Skills(f.config);
  await skills.discover();
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      throw new Error('No model calls expected');
    },
  });
  try {
    const fetch = handler(service);
    const response = await fetch(new Request('http://localhost/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain('Integration guide');
    expect(html).not.toContain('<script');
    expect(html).not.toContain(f.config.token);
    expect(html).not.toContain(f.config.apiKey!);
    for (const path of ['/llm.txt', '/llms.txt']) {
      const guide = await fetch(new Request('http://localhost' + path));
      expect(guide.status).toBe(200);
      expect(guide.headers.get('content-type')).toContain('text/plain');
      const text = await guide.text();
      expect(text).toBe(await Bun.file('llm.txt').text());
      expect(text).toContain('integrating with an installed Auto-Agent service');
      expect(text).toContain('auto-agent serve');
      expect(text).toContain('POST /session');
      expect(text).not.toMatch(
        /npm run dev|examples\/|build:windows|build:linux|Bun build plugin|Linux CI/,
      );
    }
    expect((await fetch(new Request('http://localhost/session'))).status).toBe(401);
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
});
