import { expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import { fixture } from '../helpers';
import { McpClients } from '../../src/mcp/client';
import { mcpServerSchema } from '../../src/mcp/config';
import { Store } from '../../src/storage';
import { AgentService } from '../../src/agent';
import { Skills } from '../../src/skill';
import { ScriptExecutor } from '../../src/execution';

test('generic MCP exposes only host-enabled namespaced tools and validates input/contracts', async () => {
  const f = await fixture();
  f.config.configPath = join(f.dir, 'runtime', 'backend.json');
  f.config.mcpServers = {
    helper: mcpServerSchema.parse({
      command: process.execPath,
      args: ['--no-env-file', resolve('tests/fixtures/mcp-server.ts')],
      tools: { echo: 'read', 'read-command': 'read', working_directory: 'read' },
      cwd: f.dir,
      timeoutMs: 2000,
    }),
  };
  Object.setPrototypeOf(f.config.mcpServers.helper!.tools, { hidden: 'read' });
  const clients = new McpClients(f.config);
  try {
    const tools = await clients.catalog();
    expect(tools.map((t) => t.toolName).sort()).toEqual([
      'echo',
      'read-command',
      'working_directory',
    ]);
    const echo = tools.find((tool) => tool.toolName === 'echo')!;
    const named = tools.find((tool) => tool.toolName === 'read-command')!;
    expect(named.name).toMatch(/^mcp__helper__read_command_[a-f0-9]{8}$/);
    const signal = new AbortController().signal;
    const call = await clients.prepare(echo, { text: 'hello' }, signal);
    expect((await call()).structuredContent).toEqual({ text: 'hello' });
    expect((await (await clients.prepare(named, {}, signal))()).structuredContent).toEqual({
      ok: true,
    });
    const workingDirectory = tools.find((tool) => tool.toolName === 'working_directory')!;
    expect(
      (await (await clients.prepare(workingDirectory, {}, signal))()).structuredContent,
    ).toEqual({ cwd: f.dir });
    await expect(clients.prepare(echo, { text: 1 }, signal)).rejects.toThrow('schema');
    await expect(
      clients.prepare({ ...echo, fingerprint: 'changed' }, { text: 'hello' }, signal),
    ).rejects.toThrow('contract changed');
  } finally {
    await clients.close();
    await f.cleanup();
  }
}, 10000);

test('generic MCP recovery blocks unresolved writes without knowing server business rules', async () => {
  const f = await fixture();
  let store = new Store(f.config.dataDir);
  try {
    const session = store.createSession();
    const message = store.addMessage(session.id, 'user', 'deploy');
    const run = store.beginRun(session.id, message.id);
    const operation = store.beginToolOperation(
      run,
      'helper',
      'deploy',
      'input-hash',
      'helper-command',
    );
    store.close();
    store = new Store(f.config.dataDir);
    expect(store.pendingReview(session.id)?.operations[0]).toMatchObject({
      id: operation,
      status: 'unknown',
      diagnostic: { code: 'OUTCOME_UNKNOWN' },
    });
    expect(
      store.db.query("SELECT name FROM sqlite_master WHERE name='device_claims'").get(),
    ).toBeNull();
    const other = store.createSession();
    const next = store.beginRun(
      other.id,
      store.addMessage(other.id, 'user', 'another operation').id,
    );
    expect(() =>
      store.beginToolOperation(next, 'alias', 'deploy', 'new-input', 'helper-command'),
    ).toThrow('unresolved write');
    store.resolveReview(session.id, run, '核对后结束此轮，不重放');
    expect(store.db.query('SELECT status FROM tool_operations WHERE id=?').get(operation)).toEqual({
      status: 'unknown',
    });
    const continued = store.beginToolOperation(
      next,
      'helper',
      'deploy',
      'new-input',
      'helper-command',
    );
    store.finishToolOperation(continued, 'confirmed');
  } finally {
    store.close();
    await f.cleanup();
  }
});

test('cancelling during MCP discovery persists a cancelled run and reply', async () => {
  const f = await fixture();
  f.config.mcpServers = {
    helper: mcpServerSchema.parse({
      command: process.execPath,
      args: ['--no-env-file', resolve('tests/fixtures/mcp-server.ts'), '--delay-initialize'],
      tools: { echo: 'read' },
      timeoutMs: 60000,
    }),
  };
  const store = new Store(f.config.dataDir),
    skills = new Skills(f.config);
  await skills.discover();
  let calls = 0;
  const service = new AgentService(f.config, store, skills, new ScriptExecutor(f.config, skills), {
    async generate() {
      calls++;
      return { text: 'unexpected', toolCalls: [], usage: { totalTokens: 1 } };
    },
  });
  try {
    const session = store.createSession();
    const done = service.submit(session.id, 'wait');
    void done.catch(() => {});
    await Bun.sleep(25);
    expect(await service.abort(session.id)).toBe(true);
    await expect(done).rejects.toThrow('cancelled');
    expect(store.messages(session.id).at(-1)?.content).toContain('Generation cancelled');
    expect(store.db.query('SELECT status FROM runs').get()).toEqual({ status: 'cancelled' });
    expect(calls).toBe(0);
  } finally {
    await service.shutdown();
    store.close();
    await f.cleanup();
  }
}, 10000);
