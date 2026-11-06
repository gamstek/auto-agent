// Historical bridge-v3 verification. The current desktop connects to Corax directly.
import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm, cp, symlink, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { messageText, type CoraxMessage } from '@auto-agent/desktop-protocol';

const modes = [
  'dev',
  'start',
  ...(process.env.AUTO_AGENT_TEST_BACKEND ? ['packaged'] : []),
] as const;
for (const mode of modes)
  test(`released Corax ${mode} serves native chat and executes the real Wiki tool`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'auto-agent-corax-test-'));
    const token = crypto.randomUUID();
    let usedWiki = false;
    let requests = 0;
    let observedAfterClear = false;
    let oldContextAfterClear = false;
    let sawConfiguredRole = false;
    let duplicatedRole = false;
    let missingRole = false;
    let expectedOutputTokens = 1234;
    let sawRestartedRole = false;
    const firstRequest = Promise.withResolvers<void>();
    const firstReply = Promise.withResolvers<void>();
    const mock = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          max_tokens?: number;
          messages: { role: string; content: unknown }[];
          tools?: { function: { name: string } }[];
        };
        requests++;
        expect(body.max_tokens).toBe(expectedOutputTokens);
        const systemText = body.messages
          .filter((message) => message.role === 'system')
          .map((message) => JSON.stringify(message.content))
          .join('\n');
        if (expectedOutputTokens === 1234) {
          sawConfiguredRole ||= systemText.includes('你是测试知识库助手');
          duplicatedRole ||= systemText.split('你是测试知识库助手').length > 2;
          if (body.tools?.some((tool) => tool.function.name === 'wiki'))
            missingRole ||= !systemText.includes('你是测试知识库助手');
        } else sawRestartedRole ||= systemText.includes('此角色只应在重启后生效。');
        if (JSON.stringify(body.messages).includes('清空后新问题')) {
          observedAfterClear = true;
          oldContextAfterClear ||= body.messages.some(
            (message) =>
              message.role === 'user' &&
              (message.content === '请使用 wiki 查看知识源。' ||
                (Array.isArray(message.content) &&
                  message.content.some((part) => part?.text === '请使用 wiki 查看知识源。'))),
          );
        }
        if (requests === 1) {
          firstRequest.resolve();
          await firstReply.promise;
        }
        usedWiki ||= body.messages.some(
          (message) =>
            message.role === 'tool' && JSON.stringify(message.content).includes('sources'),
        );
        const tool = body.tools?.find((value) => value.function.name === 'wiki');
        const call = !usedWiki && tool;
        const chunk = (delta: unknown, finish_reason: string | null = null) => ({
          id: 'mock-completion',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, delta, finish_reason }],
        });
        const parts = [
          chunk({ role: 'assistant' }),
          chunk({ reasoning_content: '先核对知识源，再回答。' }),
          call
            ? chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: 'wiki-call',
                    type: 'function',
                    function: { name: 'wiki', arguments: '{"action":"catalog"}' },
                  },
                ],
              })
            : chunk({ content: usedWiki ? 'Wiki 已连接' : '未找到 Wiki 工具。' }),
          chunk({}, call ? 'tool_calls' : 'stop'),
          {
            ...chunk({}),
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
          },
        ];
        return new Response(
          new ReadableStream({
            async start(controller) {
              try {
                const encode = (value: unknown) =>
                  new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
                for (let index = 0; index < parts.length; index++) {
                  if (!call && index === 3) {
                    await Bun.sleep(1500);
                    controller.enqueue(encode(chunk({ content: '，已读取知识源。' })));
                  }
                  controller.enqueue(encode(parts[index]));
                }
                controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            },
          }),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      },
    });
    const config = join(temporary, 'config.json');
    await writeFile(
      config,
      JSON.stringify({
        dataDir: './data',
        model: 'test-model',
        baseURL: `http://127.0.0.1:${mock.port}/v1`,
        wiki: { builtin: true },
        maxInputTokens: 128000,
        maxOutputTokens: 1234,
        systemPrompt: '你是测试知识库助手。',
      }),
    );
    const root = resolve(import.meta.dir, '../..');
    const packaged = process.env.AUTO_AGENT_TEST_BACKEND;
    const project = mode === 'packaged' ? resolve(packaged!) : join(temporary, 'project');
    if (mode !== 'packaged') await mkdir(project);
    // Isolate Corax's workflow/event databases as well as the Wiki database.
    for (const name of mode === 'packaged'
      ? []
      : ['agent.ts', 'instructions.ts', 'lib', 'tools', 'channels', 'package.json'])
      await cp(join(root, name), join(project, name), { recursive: true });
    for (const name of mode === 'packaged'
      ? []
      : [
          '@coraxjs/core',
          'ai',
          'zod',
          '@auto-agent/wiki-core',
          '@auto-agent/wiki-sam',
          '@ai-sdk/openai-compatible',
        ]) {
      const destination = join(project, 'node_modules', name);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(await realpath(join(root, 'node_modules', name)), destination, 'junction');
    }
    const environment = {
      ...process.env,
      NODE_ENV: mode === 'dev' ? 'development' : 'production',
      CORAX_MOCK_AUTHORED_MODELS: '0',
      AUTO_AGENT_API_KEY: 'local-test-key',
      AUTO_AGENT_TOKEN: token,
      AUTO_AGENT_CORAX_PROJECT: project,
      AUTO_AGENT_CORAX_MODE: mode === 'packaged' ? 'start' : mode,
      AUTO_AGENT_CONFIG: config,
      AUTO_AGENT_PROJECT_ROOT: mode === 'packaged' ? project : root,
      CORAX_PROJECT_ROOT: project,
      CORAX_DATA_DIR: join(temporary, 'data/corax'),
    };
    if (mode === 'start') {
      const build = Bun.spawn(
        ['node', fileURLToPath(import.meta.resolve('@coraxjs/core/bin')), 'build'],
        { cwd: project, env: environment, stdout: 'pipe', stderr: 'pipe' },
      );
      const [code, stdout, stderr] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
    }
    const child = Bun.spawn(
      mode === 'packaged'
        ? [
            join(project, process.platform === 'win32' ? 'node.exe' : 'node'),
            join(project, 'bridge.mjs'),
            '--config',
            config,
          ]
        : ['node', '--import', 'tsx', 'scripts/desktop-backend.ts', '--config', config],
      {
        cwd: root,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: environment,
      },
    );
    let diagnostics = '';
    const drain = (async () => {
      for await (const bytes of child.stderr)
        diagnostics = (diagnostics + new TextDecoder().decode(bytes)).slice(-16000);
    })();
    let host = '';
    try {
      host = await Promise.race([
        (async () => {
          let text = '';
          for await (const bytes of child.stdout) {
            text += new TextDecoder().decode(bytes);
            for (const line of text.split('\n')) {
              try {
                const value = JSON.parse(line);
                if (value.event === 'listening') return value.url as string;
              } catch {}
            }
          }
          throw new Error('Backend exited: ' + diagnostics);
        })(),
        Bun.sleep(115000).then(() => {
          throw new Error('Startup timeout: ' + diagnostics);
        }),
      ]);
      async function api(path: string, body?: unknown) {
        const response = await fetch(host + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok)
          throw new Error(`${path}: ${response.status} ${await response.text()}\n${diagnostics}`);
        return response.status === 204 ? null : response.json();
      }
      const health = await api('/global/health');
      expect(health.engine).toBe('corax');
      expect(health.protocolVersion).toBe(3);
      expect(health.capabilities.sessions.cancel).toBe(true);
      expect(health.capabilities.events.snapshot).toBe(true);
      expect(health.capabilities.messages.reasoning).toBe(true);
      expect(health.capabilities).not.toHaveProperty('inspection');
      expect(health.capabilities).not.toHaveProperty('persistedReasoning');
      expect(health.capabilities).not.toHaveProperty('conversationProcess');
      expect((await fetch(host + '/wiki/catalog')).status).toBe(401);
      if (mode === 'dev') {
        const registry = JSON.parse(
          await readFile(join(temporary, 'data/corax/dev-server-state.v1.json'), 'utf8'),
        );
        expect((await fetch(new URL('/corax/v1/session', registry.url))).status).toBe(401);
      }
      expect((await api('/wiki/catalog')).sources.length).toBeGreaterThan(0);
      const session = await api('/session', {});
      await api(`/session/${session.id}/prompt_async`, { content: '请使用 wiki 查看知识源。' });
      expect((await api('/runtime')).busy).toBe(true);
      await Promise.race([
        firstRequest.promise,
        Bun.sleep(15000).then(() => {
          throw new Error('Local mock model was not called');
        }),
      ]);
      const changedConfig = JSON.parse(await readFile(config, 'utf8'));
      changedConfig.maxOutputTokens = 2345;
      changedConfig.systemPrompt = '此角色只应在重启后生效。';
      await writeFile(config, JSON.stringify(changedConfig));
      expect(
        (
          await fetch(host + '/desktop/shutdown', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(409);
      firstReply.resolve();
      const deadline = Date.now() + 45000;
      let sawStreaming = false;
      let messages: readonly CoraxMessage[] = [];
      while (Date.now() < deadline) {
        const live = await api(`/session/${session.id}/conversation`);
        sawStreaming ||=
          live.busy &&
          live.conversation.messages.some((message: any) =>
            message.parts.some(
              (part: any) =>
                part.type === 'text' &&
                part.text.includes('Wiki 已连接') &&
                part.state === 'streaming',
            ),
          );
        messages = live.conversation.messages;
        if (messages.some((message) => messageText(message).includes('Wiki 已连接')) && !live.busy)
          break;
        await Bun.sleep(50);
      }
      expect(
        messages.some(
          (message) => message.role === 'assistant' && messageText(message).includes('Wiki 已连接'),
        ),
        JSON.stringify({ requests, messages }) + '\n' + diagnostics,
      ).toBe(true);
      expect(usedWiki).toBe(true);
      expect(sawConfiguredRole).toBe(true);
      expect(duplicatedRole).toBe(false);
      expect(
        messages.filter((message) => messageText(message) === 'Wiki 已连接，已读取知识源。'),
      ).toHaveLength(1);
      expect(sawStreaming).toBe(true);
      expect(existsSync(join(project, '.corax'))).toBe(false);
      expect(existsSync(join(temporary, 'data/corax/.workflow-data'))).toBe(true);
      expect(existsSync(join(temporary, 'data/corax-desktop.sqlite'))).toBe(false);
      expect((await api('/session?limit=50')).some((row: any) => row.id === session.id)).toBe(true);
      expect(requests).toBeGreaterThanOrEqual(2);
      expect(
        (await api(`/session/${session.id}/events`)).events.some(
          (event: { type: string }) => event.type === 'action.result',
        ),
      ).toBe(true);
      const structured = await api(`/session/${session.id}/conversation`);
      const timing = Object.values(structured.turnDetails)[0] as {
        startedAt: number;
        endedAt: number;
      };
      expect(timing.endedAt).toBeGreaterThanOrEqual(timing.startedAt);
      expect(structured.calls['wiki-call'].status).toBe('completed');
      expect(Object.keys(structured.conversation.turns).length).toBeGreaterThan(0);
      expect(structured.conversation.messages.length).toBeGreaterThan(0);
      expect(
        structured.conversation.messages.some((message: any) =>
          message.parts.some(
            (part: any) => part.type === 'reasoning' && part.text.includes('核对知识源'),
          ),
        ),
      ).toBe(true);
      const cancelledSession = await api('/session', {});
      await api(`/session/${cancelledSession.id}/prompt_async`, {
        content: '这是需要取消的一轮。',
      });
      expect((await api(`/session/${cancelledSession.id}/abort`, {})).status).toBe('accepted');
      const cancelDeadline = Date.now() + 15000;
      let cancelled;
      do {
        cancelled = await api(`/session/${cancelledSession.id}/conversation`);
        if (!cancelled.busy) break;
        await Bun.sleep(100);
      } while (Date.now() < cancelDeadline);
      expect(cancelled.busy).toBe(false);
      expect(
        Object.values(cancelled.conversation.turns).some(
          (turn: any) => turn.status === 'cancelled',
        ),
      ).toBe(true);
      expect((await api(`/session/${session.id}/clear`, {})).status).toBe('accepted');
      const clearDeadline = Date.now() + 10000;
      let cleared = false;
      do {
        cleared = (await api(`/session/${session.id}/events`)).events.some(
          (event: any) => event.type === 'context.cleared',
        );
        if (!cleared) await Bun.sleep(100);
      } while (!cleared && Date.now() < clearDeadline);
      expect(cleared).toBe(true);
      expect(
        (await api(`/session/${session.id}/conversation`)).conversation.messages.length,
      ).toBeGreaterThan(0);
      await api(`/session/${session.id}/prompt_async`, { content: '清空后新问题' });
      const nextDeadline = Date.now() + 15000;
      while (Date.now() < nextDeadline) {
        if (observedAfterClear && !(await api(`/session/${session.id}/conversation`)).busy) break;
        await Bun.sleep(100);
      }
      expect(observedAfterClear).toBe(true);
      expect(oldContextAfterClear).toBe(false);
      const afterClear = await api(`/session/${session.id}/conversation`);
      expect((Object.values(afterClear.conversation.turns).at(-1) as any)?.status).toBe(
        'completed',
      );
      expect((await api('/runtime')).busy).toBe(false);
      expect(missingRole).toBe(false);
      expect(duplicatedRole).toBe(false);
      await api('/desktop/shutdown', {});
      expect(await child.exited).toBe(0);
      expectedOutputTokens = 2345;
      const restarted = Bun.spawn(
        mode === 'packaged'
          ? [
              join(project, process.platform === 'win32' ? 'node.exe' : 'node'),
              join(project, 'bridge.mjs'),
              '--config',
              config,
            ]
          : ['node', '--import', 'tsx', 'scripts/desktop-backend.ts', '--config', config],
        { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: environment },
      );
      const restartedDiagnostics = new Response(restarted.stderr).text();
      try {
        host = await Promise.race([
          (async () => {
            let text = '';
            for await (const bytes of restarted.stdout) {
              text += new TextDecoder().decode(bytes);
              for (const line of text.split('\n')) {
                try {
                  const value = JSON.parse(line);
                  if (value.event === 'listening') return value.url as string;
                } catch {}
              }
            }
            throw new Error('Restart exited: ' + (await restartedDiagnostics));
          })(),
          Bun.sleep(30000).then(() => {
            throw new Error('Restart did not become ready');
          }),
        ]);
        const next = await api('/session', {});
        await api(`/session/${next.id}/prompt_async`, { content: '验证配置重启后生效' });
        const restartDeadline = Date.now() + 15000;
        while (Date.now() < restartDeadline) {
          if (sawRestartedRole && !(await api('/runtime')).busy) break;
          await Bun.sleep(50);
        }
        expect(sawRestartedRole).toBe(true);
        expect((await api('/runtime')).busy).toBe(false);
        await api('/desktop/shutdown', {});
        expect(await restarted.exited).toBe(0);
      } finally {
        if (restarted.exitCode === null) {
          restarted.stdin.end();
          await Promise.race([restarted.exited, Bun.sleep(10000)]);
        }
        if (restarted.exitCode === null) restarted.kill();
        await restarted.exited;
        await restartedDiagnostics;
      }
    } catch (error) {
      console.error(diagnostics);
      throw error;
    } finally {
      firstReply.resolve();
      if (child.exitCode === null) {
        child.stdin.end();
        await Promise.race([child.exited, Bun.sleep(10000)]);
      }
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      await drain;
      await mock.stop(true);
      await rm(temporary, { recursive: true, force: true, maxRetries: 5 }).catch((error) =>
        console.error('Fixture cleanup:', error.message),
      );
    }
  }, 180000);
