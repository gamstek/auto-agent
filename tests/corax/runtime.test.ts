import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, cp, rm, symlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Client, conversationReducer } from '@coraxjs/core/client';

for (const mode of [
  'development',
  'start',
  ...(process.env.AUTO_AGENT_TEST_BACKEND ? ['packaged'] : []),
])
  test(`native Corax ${mode} exposes sessions, Wiki tools and host activity without a bridge`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'auto-agent-native-corax-'));
    const root = resolve(import.meta.dirname, '../..');
    const project =
      mode === 'packaged'
        ? resolve(process.env.AUTO_AGENT_TEST_BACKEND!)
        : join(temporary, 'project');
    let usedWiki = false;
    const writes: unknown[] = [];
    let task: { batchId: string; state: string; experiments?: unknown[] } | null = null;
    const health = {
      softwareReady: true,
      deviceConnected: true,
      deviceBusy: false,
      simulation: true,
    };
    const vendor = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET')
          return Response.json({
            ok: true,
            data: path.endsWith('/health') ? health : { health, task },
          });
        const input = await request.json();
        writes.push(input);
        task = path.endsWith('/tasks')
          ? { batchId: input.batchId, state: 'READY', experiments: input.experiments }
          : { ...task!, state: 'RUNNING' };
        return Response.json({ ok: true, data: { task } });
      },
    });
    const calls = [
      { name: 'wiki', arguments: { action: 'catalog', collection: 'reference' } },
      {
        name: 'wiki',
        arguments: {
          action: 'search',
          collection: 'reference',
          query: 'BET',
          filters: { 'sam.product': 'g5' },
          limit: 1,
        },
      },
      { name: 'wiki', arguments: { action: 'catalog', collection: 'knowledge' } },
      { name: 'sam_file', arguments: { operation: 'profiles', input: { product: 'g5' } } },
      { name: 'climber_get_health', arguments: {} },
      { name: 'climber_get_status', arguments: {} },
      {
        name: 'climber_register_batch',
        arguments: {
          batchId: 'LOCAL-BATCH',
          experiments: [
            {
              experimentId: 'LOCAL-EXP',
              analysisPort: 1,
              tubeNo: 109,
              samPath: 'E:\\templates\\local.SAM',
              sampleName: 'Local fixture',
              emptyTubeMassG: 29.1,
              sampleMassG: 1.5,
            },
          ],
        },
      },
      { name: 'climber_start_batch', arguments: { batchId: 'LOCAL-BATCH' } },
    ];
    let nextCall = 0;
    const mock = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          tools?: { function: { name: string } }[];
          messages: { role: string; content: unknown }[];
          max_tokens?: number;
        };
        expect(body.max_tokens).toBe(1234);
        expect(
          body.tools?.some((tool) => ['device_reference', 'llm_wiki'].includes(tool.function.name)),
        ).toBe(false);
        usedWiki ||= body.messages.some(
          (message) =>
            message.role === 'tool' && JSON.stringify(message.content).includes('documentCount'),
        );
        const call = calls[nextCall++];
        if (call)
          expect(
            body.tools?.some((tool) => tool.function.name === call.name),
            JSON.stringify({
              wanted: call.name,
              available: body.tools?.map((tool) => tool.function.name),
            }),
          ).toBe(true);
        const chunk = (delta: unknown, finish_reason: string | null = null) => ({
          id: 'local',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'local',
          choices: [{ index: 0, delta, finish_reason }],
        });
        const parts = [
          chunk({ role: 'assistant' }),
          call
            ? chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: `local-call-${nextCall}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  },
                ],
              })
            : chunk({ content: 'Wiki 已连接；Climber MCP 已连接' }),
          chunk({}, call ? 'tool_calls' : 'stop'),
        ];
        return new Response(
          parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const token = crypto.randomUUID();
    const config = join(temporary, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        dataDir: temporary,
        model: 'local',
        baseURL: `http://127.0.0.1:${mock.port}/v1`,
        maxOutputTokens: 1234,
        climber: { enabled: true, serviceURL: `${vendor.url.origin}/api/v1`, timeoutMs: 1000 },
      }),
    );
    if (mode !== 'packaged') {
      await mkdir(project);
      for (const name of [
        'agent.ts',
        'instructions.ts',
        'lib',
        'tools',
        'channels',
        'skills',
        'scripts',
        'package.json',
      ])
        await cp(join(root, name), join(project, name), { recursive: true });
      for (const name of [
        '@coraxjs/core',
        'ai',
        'zod',
        '@ai-sdk/openai-compatible',
        '@auto-agent/llm-wiki',
        '@auto-agent/climber-mcp',
        '@auto-agent/desktop-protocol',
        '@modelcontextprotocol/sdk',
        'tsx',
      ]) {
        const target = join(project, 'node_modules', name);
        await mkdir(dirname(target), { recursive: true });
        await symlink(await realpath(join(root, 'node_modules', name)), target, 'junction');
      }
    }
    const env = {
      ...process.env,
      // Bun's test NODE_ENV enables Corax's authored-model stubs, bypassing this HTTP fake.
      NODE_ENV: mode === 'development' ? 'development' : 'production',
      AUTO_AGENT_CONFIG: config,
      AUTO_AGENT_TOKEN: token,
      AUTO_AGENT_API_KEY: 'local-key',
      AUTO_AGENT_PROJECT_ROOT: project,
      CORAX_PROJECT_ROOT: project,
      CORAX_DATA_DIR: join(temporary, 'corax'),
      CORAX_MOCK_AUTHORED_MODELS: '0',
    };
    const cli =
      mode === 'development'
        ? join(project, 'scripts/corax.ts')
        : mode === 'packaged'
          ? join(project, 'node_modules/@coraxjs/core/bin/corax.js')
          : fileURLToPath(import.meta.resolve('@coraxjs/core/bin'));
    const runtime =
      mode === 'packaged'
        ? join(project, process.platform === 'win32' ? 'node.exe' : 'node')
        : 'node';
    if (mode === 'start') {
      const build = Bun.spawn([runtime, cli, 'build'], {
        cwd: project,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, output, errors] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ]);
      expect(code, output + errors).toBe(0);
    }
    const command = [
      runtime,
      ...(mode === 'development' ? ['--import', 'tsx'] : []),
      cli,
      mode === 'development' ? 'dev' : 'start',
      ...(mode === 'development' ? ['--no-ui'] : []),
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ];
    let child = Bun.spawn(command, { cwd: project, env, stdout: 'pipe', stderr: 'pipe' });
    let errors = new Response(child.stderr).text();
    const ready = async () => {
      let text = '';
      for await (const chunk of child.stdout) {
        text += new TextDecoder().decode(chunk);
        const match = /server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(
          text.replace(/\x1b\[[0-9;]*m/g, ''),
        );
        if (match) return match[1]!;
      }
      throw new Error(await errors);
    };
    const stop = async () => {
      if (process.platform === 'win32' && child.exitCode === null)
        await Bun.spawn(['taskkill', '/PID', String(child.pid), '/T', '/F'], {
          stdout: 'ignore',
          stderr: 'ignore',
        }).exited;
      else child.kill();
      await child.exited;
      return await errors;
    };
    try {
      const host = await Promise.race([
        ready(),
        Bun.sleep(110000).then(() => {
          throw new Error('Corax did not become ready');
        }),
      ]);
      const client = new Client({
        host,
        auth: { basic: { username: 'auto-agent', password: token } },
      });
      await client.health();
      const profiling = process.env.AUTO_AGENT_PROFILE_CHAT === '1';
      const timings: Record<string, unknown> = {};
      const probe = async (name: string, path: string, init?: RequestInit) => {
        const started = performance.now();
        const response = await client.fetch(path, init);
        const headers = performance.now();
        const text = await response.text();
        timings[name] = {
          status: response.status,
          headersMs: Math.round(headers - started),
          bodyMs: Math.round(performance.now() - headers),
          bytes: Buffer.byteLength(text),
        };
      };
      const createdAt = performance.now();
      const { session } = await client.sessions.create();
      timings.createMs = Math.round(performance.now() - createdAt);
      if (profiling)
        await probe(
          'coldHistory',
          `/corax/v1/session/${session.state.sessionId}/stream?startIndex=0&follow=false`,
        );
      const response = await session.send(
        '本地模拟验证：查询 Wiki，检查 SAM 配置，并登记、启动 LOCAL-BATCH 测试批次。',
      );
      const result = await response.result();
      expect(result.message).toContain('Wiki 已连接');
      expect(usedWiki).toBe(true);
      expect(result.message).toContain('Climber MCP 已连接');
      expect(writes).toHaveLength(2);
      const snapshot = await session.snapshot();
      const conversation = snapshot.events.reduce(
        (state, event) => conversationReducer.reduce(state, event),
        conversationReducer.initial(),
      );
      expect(conversation.messages.some((message) => message.role === 'assistant')).toBe(true);
      const reloaded = await client.sessions.attach(session.state.sessionId).snapshot();
      expect(
        reloaded.events.some(
          (event) =>
            event.type === 'message.completed' && event.data.message.includes('Wiki 已连接'),
        ),
      ).toBe(true);
      const activity = await client.fetch('/desktop/activity', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions: [{ id: session.state.sessionId, after: null }] }),
      });
      expect(activity.ok).toBe(true);
      expect((await activity.json()).sessions[0].busy).toBe(false);
      const devices = await client.fetch('/desktop/devices/climber/refresh', { method: 'POST' });
      expect(devices.ok).toBe(true);
      const device = await devices.json();
      expect(device.transport).toBe('connected');
      expect(device.task.batchId).toBe('LOCAL-BATCH');
      expect(device.task.state).toBe('RUNNING');
      expect((await fetch(`${host}/desktop/devices`)).status).toBe(401);
      if (profiling) {
        await probe('sessionList', '/corax/v1/session?limit=50&offset=0');
        await probe(
          'history',
          `/corax/v1/session/${session.state.sessionId}/stream?startIndex=0&follow=false`,
        );
        await probe(
          'historyAgain',
          `/corax/v1/session/${session.state.sessionId}/stream?startIndex=0&follow=false`,
        );
        await probe('activity', '/desktop/activity', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessions: [{ id: session.state.sessionId, after: null }] }),
        });
        console.log(
          JSON.stringify({
            runtime: 'Node.js 24+',
            events: snapshot.events.length,
            timings,
          }),
        );
      }
      if (mode === 'start') {
        await stop();
        child = Bun.spawn(command, { cwd: project, env, stdout: 'pipe', stderr: 'pipe' });
        errors = new Response(child.stderr).text();
        const restarted = await ready();
        const resumed = new Client({
          host: restarted,
          auth: { basic: { username: 'auto-agent', password: token } },
        });
        await resumed.health();
        const turn = await resumed.sessions
          .attach(session.state.sessionId)
          .send('重启后只读核对会话，不再登记或启动。');
        expect((await turn.result()).message).toContain('Wiki 已连接');
        expect(writes).toHaveLength(2);
      }
    } finally {
      const stderr = await stop();
      await mock.stop(true);
      await vendor.stop(true);
      await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
      expect(stderr).not.toContain('Queue delivery failed at the transport (loop 2)');
    }
  }, 180000);
