import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, cp, rm, symlink, realpath, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Client, ClientError, conversationReducer, type ClientSession } from '@coraxjs/core/client';

// Prewarmed sessions can still be initializing after create() returns. Only
// this explicit no-admission response may be retried; ambiguous sends propagate.
async function sendWhenReady(session: ClientSession, message: string) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      return await session.send(message);
    } catch (error) {
      if (
        !(error instanceof ClientError) ||
        error.status !== 409 ||
        error.code !== 'session_not_ready' ||
        Date.now() >= deadline
      )
        throw error;
      await Bun.sleep(100);
    }
  }
}

for (const mode of [
  'development',
  'start',
  ...(process.env.AUTO_AGENT_TEST_RUNTIME ? ['packaged'] : []),
])
  test(`native Corax ${mode} exposes sessions, Wiki tools and host activity without a bridge`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'auto-agent-native-corax-'));
    const root = resolve(import.meta.dirname, '../..');
    // Relocate the payload outside the workspace so missing production dependencies
    // cannot accidentally resolve from the developer's node_modules.
    const project = join(temporary, mode === 'development' ? 'workspace/corax' : 'project');
    let usedWiki = false;
    let usedHost = false;
    let usedHostFile = false;
    let usedSkillReference = false;
    let usedRelocatedResource = false;
    let usedResumedHost = false;
    const memoryFact = '用户偏好以三条短句总结。MEMORY-FIXTURE-PREFERENCE';
    let checkingMemory = false;
    let recalledMemory = false;
    let knowledgeModelCalls = 0;
    let suggestionModelCalls = 0;
    let releaseKnowledge!: () => void;
    const knowledgeGate = new Promise<void>((resolve) => {
      releaseKnowledge = resolve;
    });
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
    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      { name: 'memory__save_memory', arguments: { text: memoryFact } },
      {
        name: 'bash',
        arguments: {
          command:
            'printf \'HOST-SHELL-OK\\n%s\\n\' "$AUTO_AGENT_HOST_TEST"; test -z "$AUTO_AGENT_TOKEN"',
        },
      },
      {
        name: 'write_file',
        arguments: { filePath: '/workspace/host-fixture.txt', content: 'HOST-FILE-OK' },
      },
      { name: 'read_file', arguments: { filePath: '/workspace/host-fixture.txt' } },
      {
        name: 'write_file',
        arguments: { filePath: '/workspace/host-fixture.txt', content: 'HOST-FILE-UPDATED' },
      },
      { name: 'corax__skill', arguments: { name: 'device-automation' } },
      { name: 'corax__skill', arguments: { name: 'knowledge-base' } },
      {
        name: 'read_file',
        arguments: { filePath: '$HOME/.agents/skills/device-automation/references/methods.md' },
      },
      {
        name: 'read_file',
        arguments: {
          filePath: '$HOME/.agents/skills/device-automation/references/host-resource-fixture.txt',
        },
      },
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
        if (mode === 'start') expect(request.headers.get('authorization')).toBeNull();
        const body = (await request.json()) as {
          tools?: { function: { name: string } }[];
          messages: { role: string; content: unknown }[];
          max_tokens?: number;
          stream?: boolean;
        };
        const suggesting = body.messages.some(
          (message) =>
            message.role === 'system' && String(message.content).includes('<question_suggestions>'),
        );
        expect(body.max_tokens).toBe(suggesting ? 768 : 1234);
        if (suggesting) {
          suggestionModelCalls++;
          expect(body.tools ?? []).toHaveLength(0);
          const prompt = String(body.messages.find((message) => message.role === 'user')?.content);
          expect(prompt).not.toContain(env.AUTO_AGENT_TOKEN!);
          expect(JSON.parse(prompt).recentSessions[0].questions.length).toBeGreaterThan(0);
          return Response.json({
            id: 'local-suggestions',
            object: 'chat.completion',
            created: 1,
            model: 'local',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    questions: [
                      '如何核对本次测试资料中的适用条件？',
                      '如何对比已生成的 SAM 文件参数？',
                      '如何查看整理后的用户知识及其来源？',
                      '如何检查 Climber 已返回的测试回执？',
                    ],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        }
        if (body.stream !== true) {
          knowledgeModelCalls++;
          await knowledgeGate;
          const prompt = String(body.messages.find((message) => message.role === 'user')?.content);
          const input = JSON.parse(prompt.split('\n\n')[0]!);
          const answer =
            knowledgeModelCalls % 2 === 1
              ? '隔离资料说明一个可追溯的测试概念。'
              : JSON.stringify({
                  pages: [
                    {
                      path: input.source.summaryPath,
                      title: '隔离知识页',
                      type: 'source',
                      summary: '保留测试原文的来源',
                      body:
                        '# 隔离知识页\n这是本地测试知识。\n' +
                        '本地'.repeat(6000) +
                        'LONG-LINE-END',
                      sources: [input.source.reference],
                      related: [],
                    },
                  ],
                  issues: [],
                });
          return Response.json({
            id: 'local-knowledge',
            object: 'chat.completion',
            created: 1,
            model: 'local',
            choices: [
              { index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          });
        }
        if (checkingMemory)
          recalledMemory ||= body.messages.some((message) =>
            JSON.stringify(message.content).includes(memoryFact),
          );
        expect(
          body.tools?.some((tool) => ['device_reference', 'llm_wiki'].includes(tool.function.name)),
        ).toBe(false);
        usedWiki ||= body.messages.some(
          (message) =>
            message.role === 'tool' && JSON.stringify(message.content).includes('documentCount'),
        );
        for (const message of body.messages.filter((message) => message.role === 'tool')) {
          const output = JSON.stringify(message.content);
          usedHost ||=
            output.includes('HOST-SHELL-OK') && output.includes('native-host-environment');
          usedHostFile ||= output.includes('HOST-FILE-OK');
          usedSkillReference ||= output.includes('methods.md') && output.includes('totalLines');
          usedRelocatedResource ||= output.includes('HOST-INSTALLED-RESOURCE-OK');
          usedResumedHost ||= output.includes('RESUMED-HOST');
        }
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
    const knowledgeSource = join(temporary, 'knowledge-source.md');
    await writeFile(knowledgeSource, '# 隔离原文\n只用于知识库整理测试。');
    await writeFile(
      config,
      JSON.stringify({
        dataDir: temporary,
        model: 'local',
        baseURL: `http://127.0.0.1:${mock.port}/v1`,
        maxOutputTokens: 1234,
        llmWiki: { sources: [{ id: 'notes', type: 'file', path: knowledgeSource }] },
        climber: { enabled: true, serviceURL: `${vendor.url.origin}/api/v1`, timeoutMs: 1000 },
      }),
    );
    if (mode === 'packaged') {
      await cp(resolve(process.env.AUTO_AGENT_TEST_RUNTIME!), project, {
        recursive: true,
        filter: async (source) => {
          if ((await lstat(source)).isSymbolicLink())
            throw new Error(`Packaged runtime must not contain links: ${source}`);
          return true;
        },
      });
    } else {
      await mkdir(project, { recursive: true });
      for (const name of [
        'agent.ts',
        'instructions.ts',
        'sandbox.ts',
        'memory.ts',
        'lib',
        'tools',
        'channels',
        'skills',
        'package.json',
      ])
        await cp(join(root, 'corax', name), join(project, name), { recursive: true });
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
        'shelljs',
      ]) {
        const target = join(project, 'node_modules', name);
        await mkdir(dirname(target), { recursive: true });
        await symlink(await realpath(join(root, 'node_modules', name)), target, 'junction');
      }
      if (mode === 'development') {
        const workspace = dirname(project);
        await cp(join(root, 'scripts'), join(workspace, 'scripts'), { recursive: true });
        await cp(join(root, 'package.json'), join(workspace, 'package.json'));
        for (const [name, source] of [
          ['auto-agent', project],
          ['@coraxjs/core', await realpath(join(root, 'node_modules/@coraxjs/core'))],
        ]) {
          const target = join(workspace, 'node_modules', name!);
          await mkdir(dirname(target), { recursive: true });
          await symlink(source!, target, 'junction');
        }
      }
    }
    // Packaged mode adds this after deployment: its read proves the provider
    // binds the relocated installation rather than the builder's resources.
    await writeFile(
      join(project, 'skills/device-automation/references/host-resource-fixture.txt'),
      'HOST-INSTALLED-RESOURCE-OK',
    );
    const env = {
      ...process.env,
      // Bun's test NODE_ENV enables Corax's authored-model stubs, bypassing this HTTP fake.
      NODE_ENV: mode === 'development' ? 'development' : 'production',
      AUTO_AGENT_CONFIG: config,
      AUTO_AGENT_TOKEN: token,
      // The production-start fixture is an anonymous local model service.
      AUTO_AGENT_API_KEY: mode === 'start' ? undefined : 'local-key',
      AUTO_AGENT_PROJECT_ROOT: project,
      CORAX_PROJECT_ROOT: project,
      CORAX_DATA_DIR: join(temporary, 'corax'),
      CORAX_MOCK_AUTHORED_MODELS: '0',
      AUTO_AGENT_HOST_TEST: 'native-host-environment',
    };
    const cli =
      mode === 'development'
        ? join(project, '../scripts/corax.ts')
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
      const process = child,
        diagnostics = errors;
      return await new Promise<string>((resolve, reject) => {
        void (async () => {
          let text = '',
            listening = false;
          // Returning from the iterator would close stdout: later native Bash
          // progress logs then crash Corax dev with EPIPE. Drain until exit.
          for await (const chunk of process.stdout) {
            if (listening) continue;
            text = (text + new TextDecoder().decode(chunk)).slice(-65536);
            const match = /server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(
              text.replace(/\x1b\[[0-9;]*m/g, ''),
            );
            if (match) {
              listening = true;
              resolve(match[1]!);
            }
          }
          if (!listening) reject(new Error(await diagnostics));
        })().catch(reject);
      });
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
      let activeClient = client;
      await client.health();
      const information = await client.info();
      expect(information.sandbox.provider).toBe('host');
      for (const name of ['bash', 'read_file', 'write_file', 'web_fetch'])
        expect(information.tools.static.find((tool) => tool.name === name)?.owner.kind).toBe(
          'framework',
        );
      expect(information.skills.static.map((skill) => skill.name)).toContain('device-automation');
      expect(information.skills.static.map((skill) => skill.name)).toContain('knowledge-base');
      expect(information.tools.dynamic.some((provider) => provider.slug === 'climber')).toBe(true);
      expect(information.tools.static.some((tool) => tool.name === 'wiki')).toBe(true);
      expect(information.tools.static.some((tool) => tool.owner.kind === 'framework')).toBe(true);
      const dynamicCatalog = await client.fetch('/desktop/tools');
      expect(dynamicCatalog.ok).toBe(true);
      expect(
        (await dynamicCatalog.json()).providers[0].tools.map((tool: { name: string }) => tool.name),
      ).toEqual([
        'sam_file',
        'climber_get_health',
        'climber_get_status',
        'climber_register_batch',
        'climber_start_batch',
      ]);
      expect((await fetch(`${host}/desktop/tools`)).status).toBe(401);
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
      const response = await sendWhenReady(
        session,
        `本地模拟验证：查询 Wiki，检查 SAM 配置，并登记、启动 LOCAL-BATCH 测试批次。请记住我的长期偏好：${memoryFact}`,
      );
      const result = await response.result();
      expect(result.message).toContain('Wiki 已连接');
      expect(usedWiki).toBe(true);
      expect(usedHost).toBe(true);
      expect(usedHostFile).toBe(true);
      expect(usedSkillReference).toBe(true);
      expect(usedRelocatedResource).toBe(true);
      expect(await Bun.file(join(temporary, 'workspace/host-fixture.txt')).text()).toBe(
        'HOST-FILE-UPDATED',
      );
      expect(result.message).toContain('Climber MCP 已连接');
      expect(writes).toHaveLength(2);
      expect(await Bun.file(join(temporary, 'corax/memory.sqlite')).exists()).toBe(true);
      expect(await Bun.file(join(project, '.corax/memory.sqlite')).exists()).toBe(false);
      checkingMemory = true;
      recalledMemory = false;
      const other = await client.sessions.create({
        message: '这是新的对话，请按已保存的长期偏好回答。',
      });
      await other.response.result();
      expect(recalledMemory).toBe(true);
      checkingMemory = false;
      const snapshot = await session.snapshot();
      expect(
        snapshot.events.some(
          (event) => event.type === 'action.result' && event.data.status === 'failed',
        ),
      ).toBe(false);
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
      const suggestionInput = {
        sessions: [
          { id: other.session.state.sessionId, title: '隔离测试资料与 SAM', updatedAt: 100 },
        ],
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const suggestions = await client.fetch('/desktop/suggestions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(suggestionInput),
        });
        expect(suggestions.ok).toBe(true);
        expect(await suggestions.json()).toMatchObject({ source: 'model' });
      }
      expect(suggestionModelCalls).toBe(1);
      expect(writes).toHaveLength(2);
      expect(
        (await fetch(`${host}/desktop/suggestions`, { method: 'POST', body: '{}' })).status,
      ).toBe(401);
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
      if (mode === 'start' || mode === 'development') {
        await stop();
        nextCall = calls.length;
        calls.push({
          name: 'bash',
          arguments: { command: 'cat host-fixture.txt; printf RESUMED-HOST' },
        });
        const restartedToken = crypto.randomUUID();
        env.AUTO_AGENT_TOKEN = restartedToken;
        child = Bun.spawn(command, { cwd: project, env, stdout: 'pipe', stderr: 'pipe' });
        errors = new Response(child.stderr).text();
        const restarted = await ready();
        const resumed = new Client({
          host: restarted,
          auth: { basic: { username: 'auto-agent', password: restartedToken } },
        });
        activeClient = resumed;
        await resumed.health();
        const turn = await sendWhenReady(
          resumed.sessions.attach(session.state.sessionId),
          '重启后只读核对会话，不再登记或启动。',
        );
        expect((await turn.result()).message).toContain('Wiki 已连接');
        expect(usedResumedHost).toBe(true);
        expect(writes).toHaveLength(2);
        checkingMemory = true;
        recalledMemory = false;
        const afterRestart = await resumed.sessions.create({
          message: '进程已经重启，请使用保存过的长期偏好。',
        });
        await afterRestart.response.result();
        expect(recalledMemory).toBe(true);
        checkingMemory = false;
      }
      nextCall = calls.length;
      calls.push({ name: 'memory__remove_memory', arguments: { index: 0 } });
      const forgetting = await activeClient.sessions.create({ message: '忘记刚才那条长期偏好。' });
      await forgetting.response.result();
      checkingMemory = true;
      recalledMemory = false;
      const afterForget = await activeClient.sessions.create({
        message: '再开一个新对话，核对当前保留的长期偏好。',
      });
      await afterForget.response.result();
      expect(recalledMemory).toBe(false);
      checkingMemory = false;
      // The desktop can correlate native admission without first scanning the
      // conversation: HTTP deliveryId is repeated in durable event metadata.
      const receiptSession = activeClient.sessions.attach(session.state.sessionId);
      const beforeReceipt = await receiptSession.snapshot();
      let receiptResponse: Response;
      for (let attempt = 0; ; attempt++) {
        receiptResponse = await activeClient.fetch(`/corax/v1/session/${session.state.sessionId}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: '核对本条消息的原生受理身份，不执行设备操作。' }),
        });
        if (receiptResponse.status !== 409 || attempt === 24) break;
        const error = await receiptResponse.clone().json();
        if (error.code !== 'session_not_ready') break;
        await Bun.sleep(100);
      }
      expect(receiptResponse.status).toBe(202);
      const receipt = await receiptResponse.json();
      expect(receipt.sessionId).toBe(session.state.sessionId);
      expect(typeof receipt.deliveryId).toBe('string');
      let observedDelivery = false;
      for await (const event of receiptSession.stream({
        startIndex: beforeReceipt.events.length,
      })) {
        observedDelivery ||= event.meta.deliveryIds?.includes(receipt.deliveryId) ?? false;
        if (event.type === 'turn.completed' || event.type === 'turn.failed') break;
      }
      expect(observedDelivery).toBe(true);
      const knowledgeResponse = await activeClient.fetch('/desktop/knowledge');
      expect((await fetch(knowledgeResponse.url)).status).toBe(401);
      const knowledge = await knowledgeResponse.json();
      expect(knowledge.sources[0].status).toBe('pending');
      expect(knowledgeModelCalls).toBe(0);
      expect(await Bun.file(join(temporary, 'llm-wiki/.state/current.json')).exists()).toBe(false);
      const operationId = crypto.randomUUID();
      const organizing = await activeClient.fetch('/desktop/knowledge/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId,
          sourceId: 'notes',
          configRevision: knowledge.configRevision,
        }),
      });
      expect(organizing.status).toBe(202);
      releaseKnowledge();
      let operation: { id: string; state: string; completed: number; pageCount: number };
      for (let attempt = 0; ; attempt++) {
        operation = (await (await activeClient.fetch('/desktop/knowledge/operation')).json())
          .operation;
        if (!['running', 'cancelling'].includes(operation.state) || attempt === 99) break;
        await Bun.sleep(100);
      }
      expect(operation).toMatchObject({
        id: operationId,
        state: 'completed',
        completed: 1,
        pageCount: 1,
      });
      expect(knowledgeModelCalls).toBe(2);
      const organized = await (await activeClient.fetch('/desktop/knowledge')).json();
      expect(organized.sources[0].status).toBe('ready');
      expect(
        organized.pages.every(
          (page: { reference: { generation: string } }) =>
            page.reference.generation === organized.publication,
        ),
      ).toBe(true);
      const entry = organized.pages.find((page: { type: string }) => page.type === 'source');
      const preview = await activeClient.fetch('/desktop/knowledge/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference: entry.reference }),
      });
      const previewPage = await preview.json();
      expect(previewPage.text).toContain('这是本地测试知识');
      expect(previewPage.text).toContain('LONG-LINE-END');
      expect(await Bun.file(join(temporary, 'llm-wiki/.state/current.json')).exists()).toBe(true);
      expect(writes).toHaveLength(2);
    } finally {
      releaseKnowledge();
      const stderr = await stop();
      await mock.stop(true);
      await vendor.stop(true);
      await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
      expect(stderr).not.toContain('Queue delivery failed at the transport (loop 2)');
    }
  }, 180000);
