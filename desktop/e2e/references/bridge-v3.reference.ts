// Historical UI/bridge-v3 scenarios, retained as migration references rather than current IPC fixtures.
import { test, expect, type Page } from '@playwright/test';

async function mockDesktop(
  page: Page,
  options: {
    sessionCount?: number;
    failPageOnce?: boolean;
    overlapPage?: boolean;
    hasApiKey?: boolean;
    apiKeySource?: 'environment' | 'keyring';
    invalidProtocol?: boolean;
    holdStartup?: boolean;
    startError?: string;
    devicesAvailable?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({
      sessionCount = 0,
      failPageOnce = false,
      overlapPage = false,
      hasApiKey = false,
      apiKeySource = 'keyring',
      invalidProtocol = false,
      holdStartup = false,
      startError = '',
      devicesAvailable = false,
    }) => {
      (window as any).isTauri = true;
      const callbacks: Record<number, (value: unknown) => void> = {};
      const events: Record<number, { event: string; handler: number }> = {};
      const id = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
      let next = 0,
        running = false;
      let turnStartedAt: number | undefined, turnEndedAt: number | undefined;
      const messages: any[] = [];
      const assistantMessage = (streaming: boolean) => ({
        id: 'answer-1',
        role: 'assistant',
        metadata: { turnId: 'turn-1', status: streaming ? 'streaming' : 'complete' },
        parts: [
          {
            type: 'reasoning',
            id: 'reasoning-1',
            text: '先查阅资料，再整理结论。',
            state: streaming ? 'streaming' : 'done',
          },
          { type: 'text', id: 'intro-1', text: '我先加载技能并读取参考资料。', state: 'done' },
          {
            type: 'dynamic-tool',
            toolCallId: 'skill-1',
            toolName: 'corax__skill',
            state: 'output-available',
            input: { name: 'hello-world' },
            output: '技能已加载：hello-world',
            toolMetadata: { corax: { kind: 'load-skill', name: 'hello-world', label: '加载技能' } },
          },
          {
            type: 'dynamic-tool',
            toolCallId: 'read-1',
            toolName: 'read',
            state: streaming ? 'input-available' : 'output-available',
            input: { path: 'reference.txt' },
            ...(streaming ? {} : { output: '参考资料已读取，气体为 N₂。' }),
            toolMetadata: { corax: { kind: 'tool-call', name: 'read', label: '读取资料' } },
          },
          {
            type: 'text',
            id: 'answer-text',
            state: streaming ? 'streaming' : 'done',
            text: streaming
              ? 'BET 用于比表面积分析。'
              : 'BET 用于**比表面积**分析。\n\n| 参数 | 值 |\n| --- | --- |\n| 气体 | N₂ |',
          },
        ],
      });
      const settings = {
        model: 'deepseek-flash',
        baseURL: 'https://api.deepseek.com',
        dataDir: 'C:\\DesktopTest\\data',
        wiki: { builtin: true, sources: [], bundles: [] },
        maxInputTokens: 1000000,
        maxOutputTokens: 16000,
        systemPrompt: '',
      };
      const emitNative = (event: string, payload: unknown) => {
        for (const [listenerId, listener] of Object.entries(events)) {
          if (listener.event === event)
            callbacks[listener.handler]?.({ event, id: Number(listenerId), payload });
        }
      };
      const emit = (type: string, properties: unknown) =>
        emitNative('agent-event', { type, sessionId: id, properties });
      (window as any).__desktopTest = {
        invalidProtocol,
        holdStartup,
        startError,
        saves: [],
        submissions: 0,
        windowActions: [],
        sessionRequests: [],
        refreshSessions: () => emit('session.updated', {}),
        emitEvent: emitNative,
      };
      const sessionRows = Array.from({ length: sessionCount }, (_, index) => ({
        id: `wrun_${String(index + 1).padStart(26, '0')}`,
        title: `历史会话 ${index + 1}`,
        updatedAt: 1800000000000 - index,
      }));
      let maximized = false;
      (window as any).__TAURI_INTERNALS__ = {
        transformCallback(fn: (value: unknown) => void) {
          callbacks[++next] = fn;
          return next;
        },
        unregisterCallback(callback: number) {
          delete callbacks[callback];
        },
        async invoke(command: string, args: any) {
          if (command === 'update_check') {
            if ((window as any).__desktopTest.updateError)
              throw new Error('此构建尚未配置更新签名公钥');
            return {
              channel: 'beta',
              version: '2.0.0-beta.2',
              notes: (window as any).__desktopTest.updateNotes ?? '改进更新与诊断',
            };
          }
          if (command === 'update_install') throw new Error('任务仍在执行，请完成后再安装更新');
          if (command === 'export_diagnostics') return !(window as any).__desktopTest.cancelExport;
          if (command === 'window_action') {
            (window as any).__desktopTest.windowActions.push(args.action);
            if (args.action === 'toggle-maximize') maximized = !maximized;
            return { maximized };
          }
          if (command === 'plugin:event|listen') {
            const listenerId = ++next;
            events[listenerId] = { event: args.event, handler: args.handler };
            return listenerId;
          }
          if (command === 'plugin:event|unlisten') {
            delete events[args.eventId];
            return;
          }
          if (command === 'backend_start') {
            const state = (window as any).__desktopTest;
            state.startCalls = (state.startCalls ?? 0) + 1;
            if (state.holdStartup)
              await new Promise<void>((resolve) => {
                state.finishStartup = resolve;
              });
            if (state.startError) throw new Error(state.startError);
            return { ready: true };
          }
          if (command === 'settings_read') {
            if ((window as any).__desktopTest.externalModel) {
              settings.model = (window as any).__desktopTest.externalModel;
              delete (window as any).__desktopTest.externalModel;
            }
            return {
              settings: { ...settings },
              hasApiKey,
              apiKeySource,
              version: '2.0.0-beta.1',
              configPath: 'C:\\DesktopTest\\config.json',
              configRevision: 'test-revision',
              dataDirectory: 'C:\\DesktopTest\\data',
            };
          }
          if (command === 'settings_save') {
            if ((window as any).__desktopTest.externalModel)
              throw new Error('共享配置已被外部修改，请重新读取配置后再编辑');
            (window as any).__desktopTest.saves.push(args);
            Object.assign(settings, args.settings);
            if (args.apiKey) hasApiKey = true;
            return { saved: true, configRevision: 'test-revision' };
          }
          if (command === 'backend_request') {
            if (args.path === '/global/health')
              return (window as any).__desktopTest.invalidProtocol
                ? { healthy: true, version: '2.0.0-beta.1' }
                : {
                    healthy: true,
                    protocolVersion: 3,
                    version: '2.0.0-beta.1',
                    capabilities: (window as any).__desktopTest.capabilities ?? {
                      devices: { list: devicesAvailable },
                      sessions: {
                        create: true,
                        send: true,
                        history: true,
                        conversation: true,
                        cancel: true,
                      },
                      messages: { text: true, reasoning: true },
                      interaction: { respond: true },
                    },
                  };
            if (args.path === '/devices') {
              const state = (window as any).__desktopTest;
              state.deviceSnapshotReads = (state.deviceSnapshotReads ?? 0) + 1;
              return structuredClone(state.devices ?? []);
            }
            if (args.path === '/devices/climber-01/refresh') {
              const state = (window as any).__desktopTest;
              state.deviceRefreshes = (state.deviceRefreshes ?? 0) + 1;
              const device = state.devices[0];
              const snapshot = state.deviceOffline
                ? {
                    ...device,
                    stale: true,
                    vendorReachability: 'unreachable',
                    error: {
                      code: 'device_unavailable',
                      message: '厂家状态暂时无法更新；显示最后已知状态',
                    },
                  }
                : { ...device, stale: false, vendorReachability: 'reachable', error: null };
              snapshot.revision = (device.revision ?? 0) + 1;
              state.devices = [snapshot];
              if (state.emitDeviceOnRefresh)
                emitNative('agent-event', {
                  type: 'extension.changed',
                  properties: {
                    extension: 'instruments',
                    resourceId: 'climber-01',
                    revision: snapshot.revision,
                  },
                });
              return structuredClone(snapshot);
            }
            if (args.path === '/session' && args.method === 'POST')
              return { id, title: 'New session', updatedAt: Date.now() };
            if (args.path.startsWith('/session?')) {
              if (sessionCount) {
                const parameters = new URL(`http://localhost${args.path}`).searchParams;
                const offset = Number(parameters.get('offset') ?? 0),
                  limit = Number(parameters.get('limit') ?? 100);
                (window as any).__desktopTest.sessionRequests.push(offset);
                await new Promise((resolve) => setTimeout(resolve, 100));
                if (offset === 50 && failPageOnce) {
                  failPageOnce = false;
                  throw new Error('会话加载失败，请重试');
                }
                const rows = sessionRows.slice(offset, offset + limit);
                if (offset === 50 && overlapPage) rows[0] = sessionRows[49];
                return rows;
              }
              return messages.length ? [{ id, title: 'BET 方法咨询', updatedAt: Date.now() }] : [];
            }
            if (args.path.endsWith('/conversation')) {
              const sid = args.path.split('/')[2];
              const test = (window as any).__desktopTest;
              if (test.chatSnapshots?.[sid]) {
                const saved = structuredClone(test.chatSnapshots[sid]);
                if (test.delaySessionId === sid)
                  await new Promise((resolve) => setTimeout(resolve, 600));
                return saved;
              }
              return {
                sessionId: sid,
                revision: Date.now(),
                busy: running,
                turnActive: running,
                turnDetails:
                  turnStartedAt === undefined
                    ? {}
                    : {
                        'turn-1': {
                          startedAt: turnStartedAt,
                          endedAt: turnEndedAt,
                          compactions: [],
                        },
                      },
                calls: messages.some((message) => message.role === 'assistant')
                  ? {
                      'skill-1': { status: 'completed' },
                      'read-1': { status: running ? 'running' : 'completed' },
                    }
                  : {},
                waiting: false,
                closed: false,
                conversation: {
                  turns: messages.length
                    ? { 'turn-1': { turnId: 'turn-1', status: running ? 'active' : 'completed' } }
                    : {},
                  inputs: {},
                  tasks: {},
                  agents: {},
                  messages: structuredClone(messages),
                },
              };
            }
            if (args.path.endsWith('/respond')) {
              const test = (window as any).__desktopTest;
              (test.responses ??= []).push(args.body);
              return null;
            }
            if (args.path.endsWith('/prompt_async')) {
              (window as any).__desktopTest.submissions++;
              turnStartedAt = Date.now();
              turnEndedAt = undefined;
              messages.push({
                id: 'user-1',
                role: 'user',
                metadata: { turnId: 'turn-1', status: 'complete' },
                parts: [{ type: 'text', text: args.body.content, state: 'done' }],
              });
              running = true;
              setTimeout(() => {
                messages.push(assistantMessage(true));
                emit('conversation.changed', { revision: Date.now() });
              }, 100);
              setTimeout(() => {
                Object.assign(
                  messages.find((message) => message.id === 'answer-1'),
                  assistantMessage(false),
                );
                running = false;
                turnEndedAt = Date.now();
                emit('conversation.changed', { revision: Date.now() });
              }, 400);
              return null;
            }
            if (args.path.endsWith('/abort')) {
              running = false;
              turnEndedAt = Date.now();
              const sid = args.path.split('/')[2];
              const snapshot = (window as any).__desktopTest.chatSnapshots?.[sid];
              if (snapshot) {
                snapshot.revision++;
                snapshot.busy = false;
                snapshot.turnActive = false;
                snapshot.waiting = false;
                for (const call of Object.values(snapshot.calls) as any[])
                  if (['running', 'awaiting-input'].includes(call.status))
                    call.status = 'cancelled';
                for (const turn of Object.values(snapshot.conversation.turns) as any[])
                  turn.status = 'cancelled';
                for (const input of Object.values(snapshot.conversation.inputs) as any[]) {
                  input.status = 'settled';
                  input.outcome = 'cancelled';
                }
                emitNative('agent-event', {
                  type: 'conversation.changed',
                  sessionId: sid,
                  properties: { revision: snapshot.revision },
                });
              }
              emit('conversation.changed', { revision: Date.now() });
              return { status: 'accepted' };
            }
            throw new Error(`Unexpected mock path ${args.path}`);
          }
          return null;
        },
      };
    },
    options,
  );
}

test('startup stays on the global loading screen until Corax is ready', async ({
  page,
}, testInfo) => {
  await mockDesktop(page, { holdStartup: true });
  await page.goto('/');
  await expect(page.getByRole('main', { name: '应用启动' })).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('heading', { name: '正在启动 Corax' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).__desktopTest.finishStartup))
    .toBe('function');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '设置', exact: true })).toHaveCount(0);
  await page.keyboard.press('Control+,');
  await page.evaluate(() => (window as any).__desktopTest.emitEvent('backend-stream', 'connected'));
  await expect(page.getByRole('main', { name: '应用启动' })).toBeVisible();
  await page.getByRole('button', { name: '最小化窗口' }).click();
  expect(await page.evaluate(() => (window as any).__desktopTest.windowActions)).toContain(
    'minimize',
  );
  await page.screenshot({ path: testInfo.outputPath('startup.png') });
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.holdStartup = false;
    state.finishStartup();
  });
  await expect(page.getByRole('heading', { name: '随时可以开始。' })).toBeVisible();
  await expect(page.getByRole('main', { name: '应用启动' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__desktopTest.startCalls)).toBe(1);
});

test('startup failures show a retry screen instead of a partial workspace', async ({ page }) => {
  await mockDesktop(page, { startError: 'Corax 测试启动失败' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '启动失败' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Corax 测试启动失败');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__desktopTest.startError = '';
  });
  await page.getByRole('button', { name: '重试启动' }).click();
  await expect(page.getByRole('heading', { name: '随时可以开始。' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.startCalls)).toBe(2);
});

test('session scrollbar reaches sidebar edge and loads beyond 100 without resetting on refresh', async ({
  page,
}, testInfo) => {
  await mockDesktop(page, { sessionCount: 125 });
  await page.goto('/');
  const list = page.getByRole('region', { name: '会话列表' });
  await expect(list.locator('.nav-item')).toHaveCount(50);
  const rect = await list.boundingBox(),
    sidebar = await page.locator('.session-sidebar').boundingBox();
  expect(Math.abs(sidebar!.x + sidebar!.width - rect!.x - rect!.width)).toBeLessThanOrEqual(2);
  expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    for (let i = 0; i < 8; i++) node.dispatchEvent(new Event('scroll'));
  });
  await expect(list.locator('.nav-item')).toHaveCount(100);
  expect(
    await page.evaluate(
      () => (window as any).__desktopTest.sessionRequests.filter((n: number) => n === 50).length,
    ),
  ).toBe(1);
  await page.evaluate(() => (window as any).__desktopTest.refreshSessions());
  await expect(list).toHaveAttribute('aria-busy', 'false');
  await expect(list.locator('.nav-item')).toHaveCount(100);
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(list.locator('.nav-item')).toHaveCount(125);
  await expect(list.getByText('已显示全部会话')).toBeVisible();
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  expect(
    await page.evaluate(
      () => (window as any).__desktopTest.sessionRequests.filter((n: number) => n === 100).length,
    ),
  ).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath('session-pagination.png'),
    animations: 'disabled',
  });
});

const chatSessionA = `wrun_${'1'.padStart(26, '0')}`;
const chatSessionB = `wrun_${'2'.padStart(26, '0')}`;
function chatSnapshot(id: string, text = '流式前半段') {
  return {
    sessionId: id,
    revision: 10,
    busy: true,
    turnActive: true,
    turnDetails: { turn: { startedAt: Date.now() - 8000, compactions: [] } },
    calls: { skill: { status: 'completed' }, wiki: { status: 'running' } },
    waiting: false,
    closed: false,
    conversation: {
      turns: { turn: { turnId: 'turn', status: 'active' } },
      inputs: {},
      tasks: {},
      agents: {},
      messages: [
        {
          id: 'answer',
          role: 'assistant',
          metadata: { turnId: 'turn', status: 'streaming' },
          parts: [
            { type: 'reasoning', id: 'thinking', text: '先确认仪器资料', state: 'streaming' },
            { type: 'text', id: 'text', text, state: 'streaming' },
            {
              type: 'dynamic-tool',
              toolName: 'corax__skill',
              toolCallId: 'skill',
              state: 'output-available',
              input: { name: 'device-automation' },
              output: 'Skill 已加载',
              toolMetadata: { corax: { kind: 'load-skill', name: 'device-automation' } },
            },
            {
              type: 'dynamic-tool',
              toolName: 'wiki',
              toolCallId: 'wiki',
              state: 'input-streaming',
              inputText: '{"query":',
              toolMetadata: { corax: { kind: 'tool-call', name: 'wiki' } },
            },
          ],
        },
      ],
    },
  };
}

test('processing text shimmers without moving and respects reduced motion', async ({ page }) => {
  const time = 1_800_000_000_000;
  await page.clock.setFixedTime(new Date(time));
  await mockDesktop(page, { sessionCount: 1 });
  const value = chatSnapshot(chatSessionA);
  value.turnDetails.turn.startedAt = time - 8000;
  await page.addInitScript(
    ({ id, value }) => {
      (window as any).__desktopTest.chatSnapshots = { [id]: value };
    },
    { id: chatSessionA, value },
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^历史会话 1 / }).click();
  await expect(page.getByText('已处理 8s', { exact: true })).toBeVisible();
  const label = page.locator('.chat-thinking .processing-label');
  await expect(page.getByRole('button', { name: '正在思考', exact: true })).toBeVisible();
  const box = await label.boundingBox();
  const glyphs = label.locator('.processing-label-glyph');
  await expect
    .poll(() =>
      glyphs.evaluateAll((elements) =>
        elements.some((element) => Number(getComputedStyle(element).opacity) > 0.1),
      ),
    )
    .toBe(true);
  const before = await glyphs.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).opacity),
  );
  await page.waitForTimeout(200);
  expect(
    await glyphs.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).opacity),
    ),
  ).not.toEqual(before);
  expect(await label.boundingBox()).toEqual(box);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await glyphs.evaluateAll((elements) =>
      elements.every((element) => getComputedStyle(element).animationName === 'none'),
    ),
  ).toBe(true);
  await expect(page.getByRole('button', { name: '正在思考', exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as any).__desktopTest.emitEvent('backend-stream', 'disconnected'),
  );
  await expect(page.locator('.chat-thinking .processing-label-wave')).toHaveCount(0);
});

test('Codex-style process disclosure keeps the final answer and expands bounded command logs', async ({
  page,
}, testInfo) => {
  await mockDesktop(page, { sessionCount: 1 });
  await page.addInitScript(
    ({ id, value }) => {
      const snapshot: any = value;
      snapshot.busy = false;
      snapshot.turnActive = false;
      snapshot.conversation.turns.turn.status = 'completed';
      snapshot.turnDetails.turn = {
        startedAt: 1000,
        endedAt: 77000,
        compactions: [{ id: 'compact', stepIndex: 1 }],
      };
      const commands = Array.from({ length: 12 }, (_, index) => ({
        type: 'dynamic-tool',
        stepIndex: 0,
        toolCallId: `command-${index}`,
        toolName: 'bash',
        state: 'output-available',
        input: { command: `printf "check ${index}\\n"` },
        output: {
          status: 'completed',
          stdout: `check ${index}\n验证完成\n`,
          stderr: '',
          exitCode: 0,
          truncated: false,
        },
        toolMetadata: { corax: { kind: 'tool-call', name: 'bash', label: '运行命令' } },
      }));
      snapshot.calls = Object.fromEntries(
        commands.map((command) => [command.toolCallId, { status: 'completed' }]),
      );
      snapshot.conversation.messages = [
        {
          id: 'answer',
          role: 'assistant',
          metadata: { turnId: 'turn', status: 'complete' },
          parts: [
            {
              type: 'text',
              id: 'intro',
              stepIndex: 0,
              text: '我会先检查项目状态，再验证结果。',
              state: 'done',
            },
            ...commands,
            {
              type: 'text',
              id: 'result',
              stepIndex: 1,
              text: '检查完成，所有验证通过。',
              state: 'done',
            },
          ],
        },
      ];
      (window as any).__desktopTest.chatSnapshots = { [id]: snapshot };
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: async (text: string) => {
            (window as any).__desktopTest.copied = text;
          },
        },
      });
    },
    { id: chatSessionA, value: chatSnapshot(chatSessionA) },
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^历史会话 1 / }).click();
  await expect(page.getByText('1m 16s', { exact: true })).toBeVisible();
  const process = page.getByRole('button', { name: '处理过程', exact: true });
  const arrow = process.locator('svg');
  await expect(process).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('上下文已自动压缩', { exact: true })).toBeHidden();
  expect(await arrow.evaluate((element) => getComputedStyle(element).transform)).toBe(
    'matrix(1, 0, 0, 1, 0, 0)',
  );
  await process.click();
  await expect(process).toHaveAttribute('aria-expanded', 'true');
  await expect
    .poll(() => arrow.evaluate((element) => getComputedStyle(element).transform))
    .toBe('matrix(0, 1, -1, 0, 0, 0)');
  expect(await arrow.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    '0.16s',
  );
  await expect(page.getByText('上下文已自动压缩', { exact: true })).toBeVisible();
  await expect(page.locator('.corax-message.assistant .avatar')).toHaveCount(1);
  expect(
    await page
      .locator('.chat-output')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe('rgba(0, 0, 0, 0)');
  const group = page.getByRole('button', { name: '工具调用组（12次）', exact: true });
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await group.click();
  const list = page.locator('.chat-tool-group[data-grouped="true"] .chat-tool-group-list');
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(page.locator('.chat-tool-group[data-grouped="true"]')).toHaveAttribute(
    'data-overflow-bottom',
    'true',
  );
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(page.locator('.chat-tool-group[data-grouped="true"]')).toHaveAttribute(
    'data-overflow-bottom',
    'false',
  );
  await list.evaluate((element) => {
    element.scrollTop = 0;
  });
  const command = page.locator('.chat-tool[data-call-id="command-0"]');
  await command.locator('summary').click();
  await expect(command.getByText('Shell', { exact: true })).toBeVisible();
  await expect(command.locator('.chat-tool-command')).toContainText('$ printf');
  expect(await command.locator('.chat-tool-output').textContent()).toBe('check 0\n验证完成\n');
  await page.screenshot({ path: testInfo.outputPath('codex-process.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '处理过程', exact: true }).click();
  await expect(command).toBeHidden();
  await expect(page.getByText('检查完成，所有验证通过。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '复制回复', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__desktopTest.copied)).toBe(
    '检查完成，所有验证通过。',
  );
  await page.getByRole('button', { name: '处理过程', exact: true }).press('Enter');
  await expect(command.getByText('Shell', { exact: true })).toBeVisible();
  expect(await arrow.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    '0s',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await process.click();
  expect(await arrow.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    '0s',
  );
  expect(await page.evaluate(() => (window as any).__desktopTest.submissions)).toBe(0);
});

test('loading older native messages preserves the visible scroll anchor', async ({ page }) => {
  await mockDesktop(page, { sessionCount: 1 });
  await page.addInitScript(
    ({ id, value }) => {
      const snapshot: any = value;
      snapshot.busy = false;
      snapshot.turnActive = false;
      snapshot.calls = {};
      snapshot.conversation.turns.turn.status = 'completed';
      snapshot.turnDetails.turn.endedAt = snapshot.turnDetails.turn.startedAt + 8000;
      snapshot.conversation.messages = Array.from({ length: 100 }, (_, index) => ({
        id: `history-${index}`,
        role: 'assistant',
        metadata: { turnId: 'turn', status: 'complete' },
        parts: [{ type: 'text', state: 'done', text: `历史内容 ${index}` }],
      }));
      (window as any).__desktopTest.chatSnapshots = { [id]: snapshot };
    },
    { id: chatSessionA, value: chatSnapshot(chatSessionA) },
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^历史会话 1 / }).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(50);
  await page.locator('.conversation').evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  const anchor = page.locator('[data-message-id="history-50"]');
  const before = await anchor.evaluate((element) => element.getBoundingClientRect().top);
  await page.getByRole('button', { name: '加载更早的消息', exact: true }).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(100);
  await expect
    .poll(async () =>
      Math.abs((await anchor.evaluate((element) => element.getBoundingClientRect().top)) - before),
    )
    .toBeLessThan(2);
});

test('inactive Corax sessions retain history, stop progress indicators and carry the draft into a new chat', async ({
  page,
}) => {
  await mockDesktop(page, { sessionCount: 1 });
  await page.addInitScript(
    ({ id, value }) => {
      const snapshot: any = value;
      snapshot.closed = true;
      snapshot.busy = false;
      snapshot.turnActive = false;
      snapshot.calls.wiki = { status: 'interrupted' };
      snapshot.error = 'Corax 会话已失效';
      (window as any).__desktopTest.chatSnapshots = { [id]: snapshot };
    },
    { id: chatSessionA, value: chatSnapshot(chatSessionA, '保留的历史文本') },
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^历史会话 1 / }).click();
  await expect(page.getByText('保留的历史文本', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-thinking .spin')).toHaveCount(0);
  await expect(page.locator('.chat-tool[data-call-id="wiki"]')).toHaveAttribute(
    'data-status',
    '结果待确认',
  );
  await page.getByRole('textbox', { name: '输入消息' }).fill('保留这条未发送的草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('保留这条未发送的草稿');
  expect(await page.evaluate(() => (window as any).__desktopTest.submissions)).toBe(0);
});

test('Corax distinguishes background subagents, failed tools and denied calls', async ({
  page,
}) => {
  await mockDesktop(page, { sessionCount: 1 });
  await page.addInitScript(
    ({ id, value }) => {
      const snapshot: any = value;
      snapshot.conversation.turns.turn.status = 'completed';
      snapshot.turnDetails.turn.endedAt = snapshot.turnDetails.turn.startedAt + 8000;
      snapshot.turnActive = false;
      snapshot.calls['child-call'] = { status: 'running' };
      snapshot.calls.wiki = { status: 'interrupted' };
      snapshot.conversation.messages[0].parts.push({
        type: 'dynamic-tool',
        toolName: 'agent',
        toolCallId: 'child-call',
        state: 'output-available',
        input: {},
        output: '任务已派发',
        toolMetadata: { corax: { kind: 'subagent-call', name: '检索助手' } },
      });
      snapshot.conversation.tasks.child = {
        taskId: 'child',
        name: '检索助手',
        kind: 'agent',
        calls: { 'child-call': { callId: 'child-call', turnId: 'turn', status: 'working' } },
      };
      (window as any).__desktopTest.chatSnapshots = { [id]: snapshot };
    },
    { id: chatSessionA, value: chatSnapshot(chatSessionA) },
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^历史会话 1 / }).click();
  const child = page.locator('.chat-tool[data-call-id="child-call"]');
  await expect(child).toHaveAttribute('data-status', '执行中');
  await page.getByRole('textbox', { name: '输入消息' }).fill('继续询问其他问题');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.evaluate((id) => {
    const test = (window as any).__desktopTest,
      snapshot = test.chatSnapshots[id];
    snapshot.revision++;
    snapshot.busy = false;
    snapshot.turnActive = false;
    snapshot.conversation.turns.turn.status = 'failed';
    snapshot.turnDetails.turn.endedAt = snapshot.turnDetails.turn.startedAt + 8000;
    Object.assign(snapshot.conversation.tasks.child.calls['child-call'], {
      status: 'failed',
      error: { message: '子任务失败' },
    });
    Object.assign(snapshot.conversation.messages[0].parts[3], {
      state: 'output-error',
      errorText: '检索失败',
    });
    snapshot.conversation.messages[0].parts.push({
      type: 'dynamic-tool',
      toolCallId: 'denied',
      toolName: 'write',
      input: {},
      state: 'output-denied',
      approval: { id: 'approval', approved: false, reason: '用户拒绝了调用' },
    });
    snapshot.conversation.messages[0].parts.push({
      type: 'dynamic-tool',
      toolCallId: 'uncertain',
      toolName: 'external',
      input: {},
      state: 'input-available',
    });
    Object.assign(snapshot.calls, {
      wiki: { status: 'failed', errorText: '检索失败' },
      'child-call': { status: 'failed', errorText: '子任务失败' },
      denied: { status: 'rejected' },
      uncertain: { status: 'interrupted' },
    });
    test.emitEvent('agent-event', {
      type: 'conversation.changed',
      sessionId: id,
      properties: {},
    });
  }, chatSessionA);
  await expect(child).toHaveAttribute('data-status', '失败');
  await page.getByRole('button', { name: '处理过程', exact: true }).click();
  await child.locator('summary').click();
  await expect(child.getByText('子任务失败', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-tool[data-call-id="denied"]')).toHaveAttribute(
    'data-status',
    '已拒绝',
  );
  await expect(page.locator('.chat-thinking .spin')).toHaveCount(0);
  await expect(page.locator('.chat-tool[data-call-id="uncertain"]')).toHaveAttribute(
    'data-status',
    '结果待确认',
  );
});

test('Corax streams thinking, ordered Skill/tool parts, partial outputs and final text without duplicates', async ({
  page,
}) => {
  await mockDesktop(page, { sessionCount: 2 });
  await page.addInitScript(
    ({ id, value }) => {
      (window as any).__desktopTest.chatSnapshots = { [id]: value };
    },
    { id: chatSessionA, value: chatSnapshot(chatSessionA) },
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^历史会话 1 / }).click();
  await page.locator('.chat-thinking > button').click();
  await expect(page.getByText('先确认仪器资料', { exact: true })).toBeVisible();
  await expect(page.getByText('流式前半段', { exact: true })).toBeVisible();
  await expect(page.getByText('加载 Skill', { exact: true })).toBeVisible();
  const wiki = page.locator('.chat-tool[data-call-id="wiki"]');
  await expect(wiki).toHaveAttribute('data-status', '接收参数');
  await wiki.locator('summary').click();
  await expect(wiki.locator('pre')).toHaveText('{"query":');
  await expect(page.getByRole('button', { name: '复制回复', exact: true })).toHaveCount(0);
  await page.evaluate((id) => {
    const test = (window as any).__desktopTest;
    const value = test.chatSnapshots[id];
    value.revision++;
    Object.assign(value.conversation.messages[0].parts[3], {
      state: 'output-available',
      input: { query: 'BET' },
      output: '部分检索结果',
      partial: true,
    });
    test.emitEvent('agent-event', {
      type: 'conversation.changed',
      sessionId: id,
      properties: { revision: value.revision },
    });
  }, chatSessionA);
  await expect(wiki).toHaveAttribute('data-status', '执行中');
  await expect(wiki.getByText('部分检索结果', { exact: true })).toBeVisible();
  await page.evaluate((id) => {
    const test = (window as any).__desktopTest;
    const value = test.chatSnapshots[id];
    value.revision++;
    value.busy = false;
    value.turnActive = false;
    value.calls.wiki = { status: 'completed' };
    value.conversation.turns.turn.status = 'completed';
    value.turnDetails.turn.endedAt = value.turnDetails.turn.startedAt + 8000;
    const message = value.conversation.messages[0];
    message.metadata.status = 'complete';
    message.parts[0].state = 'done';
    message.parts[1].state = 'done';
    message.parts[1].text = '流式前半段，最终结论。';
    Object.assign(message.parts[3], { partial: false, output: '完整检索结果' });
    for (let i = 0; i < 3; i++)
      test.emitEvent('agent-event', {
        type: 'conversation.changed',
        sessionId: id,
        properties: { revision: value.revision },
      });
  }, chatSessionA);
  await expect(page.getByText('流式前半段，最终结论。', { exact: true })).toHaveCount(1);
  await expect(wiki).toHaveAttribute('data-status', '已完成');
  await expect(page.getByRole('button', { name: '复制回复', exact: true })).toHaveCount(1);
  await expect(page.locator('.chat-thinking button')).toHaveAttribute('aria-expanded', 'true');
});

test('Corax input responses submit once and cancellation settles waiting tools', async ({
  page,
}) => {
  await mockDesktop(page, { sessionCount: 1 });
  await page.addInitScript(
    ({ id, value }) => {
      const snapshot: any = value;
      snapshot.waiting = true;
      snapshot.calls.wiki = { status: 'awaiting-input' };
      Object.assign(snapshot.conversation.messages[0].parts[3], {
        state: 'approval-requested',
        input: { action: 'search', search: { query: 'BET' } },
        approval: { id: 'confirm' },
      });
      snapshot.conversation.turns.turn.waiting = true;
      snapshot.conversation.inputs.confirm = {
        status: 'open',
        turnId: 'turn',
        stepIndex: 1,
        request: {
          requestId: 'confirm',
          kind: 'tool-approval',
          display: 'confirmation',
          prompt: '是否执行这次操作？',
          action: { kind: 'tool-call', toolName: 'wiki', callId: 'wiki', input: {} },
          options: [
            { id: 'approve', label: '批准' },
            { id: 'deny', label: '拒绝' },
          ],
        },
      };
      (window as any).__desktopTest.chatSnapshots = { [id]: snapshot };
    },
    { id: chatSessionA, value: chatSnapshot(chatSessionA) },
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^历史会话 1 / }).click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeDisabled();
  await page.getByRole('button', { name: '批准', exact: true }).click();
  await expect(page.getByRole('button', { name: '批准', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__desktopTest.responses)).toEqual([
    { responses: [{ requestId: 'confirm', optionId: 'approve' }] },
  ]);
  await page.getByRole('button', { name: '取消本次回复', exact: true }).click();
  await expect(page.getByText('本轮已取消。', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-tool[data-call-id="wiki"]')).toHaveAttribute(
    'data-status',
    '已取消',
  );
  await expect(page.getByRole('button', { name: '取消本次回复', exact: true })).toHaveCount(0);
});

test('Corax reconnect retains history and delayed responses cannot overwrite another session', async ({
  page,
}) => {
  await mockDesktop(page, { sessionCount: 2 });
  await page.addInitScript(
    ({ a, b, first, second }) => {
      (window as any).__desktopTest.chatSnapshots = { [a]: first, [b]: second };
    },
    {
      a: chatSessionA,
      b: chatSessionB,
      first: chatSnapshot(chatSessionA, '会话一的文本'),
      second: chatSnapshot(chatSessionB, '会话二的文本'),
    },
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^历史会话 1 / }).click();
  await expect(page.getByText('会话一的文本', { exact: true })).toBeVisible();
  await page.evaluate(() =>
    (window as any).__desktopTest.emitEvent('backend-stream', 'disconnected'),
  );
  await expect(page.getByText('会话一的文本', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__desktopTest.emitEvent('backend-stream', 'connected'));
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.evaluate((id) => {
    const test = (window as any).__desktopTest;
    test.delaySessionId = id;
    test.emitEvent('agent-event', {
      type: 'conversation.changed',
      sessionId: id,
      properties: {},
    });
  }, chatSessionA);
  await page.getByRole('button', { name: /^历史会话 2 / }).click();
  await expect(page.getByText('会话二的文本', { exact: true })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByText('会话一的文本', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__desktopTest.submissions)).toBe(0);
});

test('session pagination preserves rows on failure, retries the same page and deduplicates IDs', async ({
  page,
}) => {
  await mockDesktop(page, { sessionCount: 120, failPageOnce: true, overlapPage: true });
  await page.goto('/');
  const list = page.getByRole('region', { name: '会话列表' });
  await expect(list.locator('.nav-item')).toHaveCount(50);
  await list.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(list.getByRole('alert')).toContainText('会话加载失败');
  await expect(list.locator('.nav-item')).toHaveCount(50);
  await list.getByRole('button', { name: '重试加载会话' }).click();
  await expect(list.locator('.nav-item')).toHaveCount(99);
  await page.getByRole('searchbox', { name: '搜索会话' }).fill('历史会话 120');
  await expect(list.locator('.nav-item')).toHaveCount(1);
  await expect(list.getByRole('button', { name: /历史会话 120/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.sessionRequests)).toEqual([
    0, 50, 50, 100,
  ]);
  await page.getByRole('searchbox', { name: '搜索会话' }).fill('');
  await expect(list.locator('.nav-item')).toHaveCount(119);
});
test('instrument page reads device facts without submitting prompts and stops polling when left', async ({
  page,
}, testInfo) => {
  await mockDesktop(page, { devicesAvailable: true });
  await page.clock.install();
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).__desktopTest.devices = [
      {
        deviceId: 'climber-01',
        name: 'Climber',
        source: 'climber-vendor',
        transport: 'connected',
        vendorReachability: 'reachable',
        health: { softwareReady: true, deviceConnected: true, deviceBusy: true },
        task: {
          batchId: 'B-1',
          state: 'RUNNING',
          experiments: [{ experimentId: 'EXP-1', analysisPort: 1, state: 'RUNNING' }],
        },
        taskKnown: true,
        observedAt: 1800000000000,
        stale: false,
        error: null,
      },
    ];
  });
  await page.getByRole('button', { name: '仪器', exact: true }).click();
  await expect(page.getByRole('heading', { name: '仪器', exact: true })).toBeVisible();
  await expect(page.getByText('批次：B-1')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'EXP-1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新状态' })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__desktopTest.deviceOffline = true;
  });
  await page.getByRole('button', { name: '刷新状态' }).click();
  await expect(page.getByText('状态待更新', { exact: true })).toBeVisible();
  await expect(page.getByText('最后已知任务', { exact: true })).toBeVisible();
  await expect(page.getByText('批次：B-1')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('instruments-stale.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const count = await page.evaluate(() => (window as any).__desktopTest.deviceRefreshes);
  await page.clock.fastForward(30000);
  expect(await page.evaluate(() => (window as any).__desktopTest.deviceRefreshes)).toBe(count);
  expect(await page.evaluate(() => (window as any).__desktopTest.submissions)).toBe(0);
});

test('instrument page does not invent a Climber when no devices are configured', async ({
  page,
}) => {
  await mockDesktop(page, { devicesAvailable: true });
  await page.goto('/');
  await page.getByRole('button', { name: '仪器', exact: true }).click();
  await expect(page.getByText('尚未配置仪器', { exact: true })).toBeVisible();
  await expect(page.locator('.instrument-card')).toHaveCount(0);
});

test('instrument notifications fetch snapshots without refresh loops and recover after reconnect', async ({
  page,
}) => {
  await mockDesktop(page, { devicesAvailable: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install({ time: new Date('2026-11-04T09:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-04T09:00:01Z'));
  await page.goto('/');
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.emitDeviceOnRefresh = true;
    state.devices = [
      {
        deviceId: 'climber-01',
        name: 'Climber',
        source: 'climber-vendor',
        transport: 'connected',
        vendorReachability: 'reachable',
        health: { softwareReady: true, deviceConnected: true, deviceBusy: false },
        task: { batchId: 'B-1', state: 'READY' },
        taskKnown: true,
        observedAt: Date.now(),
        stale: false,
        error: null,
        revision: 1,
      },
    ];
  });
  await page.getByRole('button', { name: '仪器', exact: true }).click();
  await expect(page.getByText('批次：B-1')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.deviceSnapshotReads))
    .toBe(2);
  expect(await page.evaluate(() => (window as any).__desktopTest.deviceRefreshes)).toBe(1);
  const before = await page.evaluate(() => (window as any).__desktopTest.deviceSnapshotReads);
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.devices[0] = {
      ...state.devices[0],
      task: { batchId: 'B-2', state: 'RUNNING' },
      revision: 10,
    };
    for (let i = 0; i < 8; i++)
      state.emitEvent('agent-event', {
        type: 'extension.changed',
        properties: { extension: 'instruments', resourceId: 'climber-01', revision: 10 },
      });
  });
  await expect(page.getByText('批次：B-2')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.deviceSnapshotReads))
    .toBe(before + 2);
  expect(await page.evaluate(() => (window as any).__desktopTest.deviceRefreshes)).toBe(1);
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.emitEvent('backend-stream', 'disconnected');
    state.devices[0] = {
      ...state.devices[0],
      task: { batchId: 'B-3', state: 'COMPLETED' },
      revision: 11,
    };
    state.emitEvent('backend-stream', 'connected');
  });
  await expect(page.getByText('批次：B-3')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.deviceRefreshes)).toBe(1);
  const hiddenCount = await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const state = (window as any).__desktopTest;
    state.emitEvent('agent-event', {
      type: 'extension.changed',
      properties: { extension: 'instruments', resourceId: 'climber-01', revision: 12 },
    });
    state.emitEvent('backend-stream', 'connected');
    return state.deviceSnapshotReads;
  });
  await page.clock.fastForward(30000);
  expect(await page.evaluate(() => (window as any).__desktopTest.deviceSnapshotReads)).toBe(
    hiddenCount,
  );
  await page.evaluate(() => {
    delete (document as any).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.deviceRefreshes))
    .toBe(2);
  await expect(page.getByRole('button', { name: '刷新状态' })).toBeEnabled();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const leftCount = await page.evaluate(() => (window as any).__desktopTest.deviceSnapshotReads);
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.emitEvent('agent-event', {
      type: 'extension.changed',
      properties: { extension: 'instruments', resourceId: 'climber-01', revision: 13 },
    });
    state.emitEvent('backend-stream', 'disconnected');
  });
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'disconnected');
  await page.evaluate(() => (window as any).__desktopTest.emitEvent('backend-stream', 'connected'));
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.clock.fastForward(30000);
  expect(await page.evaluate(() => (window as any).__desktopTest.deviceSnapshotReads)).toBe(
    leftCount,
  );
  expect(await page.evaluate(() => (window as any).__desktopTest.submissions)).toBe(0);
});

test('instrument listeners coexist with chat streaming subscriptions', async ({ page }) => {
  await mockDesktop(page, { devicesAvailable: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'BET 比表面积和 BJH 孔径分析有什么区别？' }).click();
  await page.getByRole('button', { name: '仪器', exact: true }).click();
  await expect(page.getByText('尚未配置仪器', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '聊天主页', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.submissions)).toBe(1);
});

test('maintenance reports updates, busy installation, export cancellation and missing signing configuration', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关于与诊断', exact: true }).click();
  const maintenance = page.getByRole('region', { name: '更新与诊断' });
  await maintenance.getByRole('button', { name: '检查更新' }).click();
  await expect(maintenance).toContainText('发现新版本 2.0.0-beta.2');
  await expect(maintenance).toContainText('改进更新与诊断');
  await maintenance.getByRole('button', { name: '下载并安装' }).click();
  await expect(maintenance).toContainText('任务仍在执行');
  await maintenance.getByRole('button', { name: '导出诊断包' }).click();
  await expect(maintenance).toContainText('诊断包已导出');
  await page.evaluate(() => {
    (window as any).__desktopTest.cancelExport = true;
    (window as any).__desktopTest.updateError = true;
  });
  await maintenance.getByRole('button', { name: '导出诊断包' }).click();
  await expect(maintenance).toContainText('已取消导出');
  await maintenance.getByRole('button', { name: '检查更新' }).click();
  await expect(maintenance).toContainText('尚未配置更新签名公钥');
  await expect(maintenance.getByRole('button', { name: '下载并安装' })).toHaveCount(0);
});

test('maintenance rows stay separated and contained at desktop and narrow widths', async ({
  page,
}, testInfo) => {
  await mockDesktop(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关于与诊断', exact: true }).click();
  const panel = page.getByRole('region', { name: '更新与诊断' });
  async function assertLayout() {
    const issues = await panel.evaluate((section) => {
      const errors: string[] = [];
      const rows = [...section.querySelectorAll('.setting-row')];
      const heading = section.querySelector('h2')!.getBoundingClientRect();
      if (heading.bottom >= rows[0].getBoundingClientRect().top)
        errors.push('heading overlaps rows');
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        const label = row.querySelector('.setting-label')!.getBoundingClientRect();
        const description = row.querySelector('.setting-copy p')!.getBoundingClientRect();
        if (label.bottom > description.top) errors.push('description overlaps label');
        const buttons = [...row.querySelectorAll('button')];
        for (const button of buttons) {
          const b = button.getBoundingClientRect();
          if (b.left < rect.left - 1 || b.right > rect.right + 1 || b.bottom > rect.bottom + 1)
            errors.push('button outside row');
          if (
            b.left < description.right &&
            b.right > description.left &&
            b.top < description.bottom &&
            b.bottom > description.top
          )
            errors.push('button overlaps description');
        }
      }
      const children = [...section.querySelector('.setting-rows')!.children].filter(
        (node) => node.getBoundingClientRect().height > 0,
      );
      for (let i = 1; i < children.length; i++) {
        if (
          children[i - 1].getBoundingClientRect().bottom >
          children[i].getBoundingClientRect().top + 1
        )
          errors.push('rows overlap');
      }
      if (section.scrollWidth > section.clientWidth + 1) errors.push('horizontal overflow');
      return errors;
    });
    expect(issues).toEqual([]);
  }
  for (const width of [1280, 900, 640]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertLayout();
  }
  await page.evaluate(() => {
    (window as any).__desktopTest.updateNotes = '版本说明\n' + 'long-release-note-'.repeat(80);
  });
  await panel.getByRole('button', { name: '检查更新' }).click();
  await expect(panel.getByRole('button', { name: '下载并安装' })).toBeVisible();
  for (const width of [1280, 900, 640]) {
    await page.setViewportSize({ width, height: 1000 });
    await assertLayout();
    await page.screenshot({
      path: testInfo.outputPath(`maintenance-${width}.png`),
      animations: 'disabled',
    });
  }
});

test('composer uses the supplied send glyph and a draggable inset scrollbar', async ({
  page,
}, testInfo) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  const send = page.getByRole('button', { name: '发送消息', exact: true });
  await expect(send).toBeDisabled();
  await expect(send.locator('[data-icon="send-plane"] polygon')).toHaveAttribute(
    'points',
    '15 14 37 23.9284171 15 34 15 26.0791964 29.9706114 24 15 21.9566435',
  );
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill(
    Array.from({ length: 40 }, (_, index) => `第${index + 1}行：多行输入滚动条验证。`).join('\n'),
  );
  const scrollbar = page.getByRole('scrollbar', { name: '输入框滚动条' });
  await expect(scrollbar).toBeVisible();
  expect(await input.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe('none');
  await scrollbar.focus();
  await page.keyboard.press('Home');
  expect(await input.evaluate((element) => element.scrollTop)).toBe(0);
  const thumb = page.locator('.composer-scroll-thumb');
  const rect = await thumb.boundingBox();
  if (!rect) throw new Error('Scrollbar thumb missing');
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + 80, { steps: 6 });
  await page.mouse.up();
  expect(await input.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const trackRect = await scrollbar.boundingBox(),
    buttonRect = await send.boundingBox();
  const composerRect = await page.locator('.composer').boundingBox();
  expect(
    composerRect!.x + composerRect!.width - trackRect!.x - trackRect!.width,
  ).toBeLessThanOrEqual(14);
  expect(trackRect!.y + trackRect!.height).toBeLessThan(buttonRect!.y);
  await page.screenshot({
    path: testInfo.outputPath('composer-multiline.png'),
    animations: 'disabled',
  });
  await input.fill('短消息');
  await expect(scrollbar).toHaveCount(0);
  await expect(send).toBeEnabled();
});
test('navigation selection is shared across pages and feedback buttons never scale on press', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'BET 比表面积和 BJH 孔径分析有什么区别？' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  const selectedSession = page.locator('.sessions .nav-item[data-selected="true"]');
  await expect(selectedSession).toBeVisible();
  const style = (element: Element) => {
    const css = getComputedStyle(element);
    return {
      background: css.backgroundColor,
      color: css.color,
      radius: css.borderRadius,
      padding: css.padding,
      fontSize: css.fontSize,
    };
  };
  const selectedStyle = await selectedSession.evaluate(style);
  for (const label of ['标记喜欢（仅本机）', '标记不喜欢（仅本机）']) {
    const button = page.getByRole('button', { name: label });
    await button.hover();
    await page.mouse.down();
    expect(await button.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
    await page.mouse.up();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const selectedSettings = page.locator('.settings-menu .nav-item[data-selected="true"]');
  await expect.poll(() => selectedSettings.evaluate(style)).toEqual(selectedStyle);
  await selectedSettings.hover();
  await page.mouse.down();
  expect(await selectedSettings.evaluate((element) => getComputedStyle(element).transform)).toBe(
    'none',
  );
  await page.mouse.up();
});

test('every settings section uses shared controls, with a thin scrollbar on long content', async ({
  page,
}, testInfo) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  for (const section of ['模型连接', '技能', '知识库', '运行参数', '关于与诊断']) {
    await page.getByRole('button', { name: section, exact: true }).click();
    await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible();
    expect(await page.locator('.settings-menu .nav-item[data-selected="true"]').count()).toBe(1);
    expect(
      await page
        .locator('.setting-control input:not([type="checkbox"])')
        .evaluateAll((inputs) => inputs.every((input) => input.classList.contains('ui-input'))),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${section}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: '运行参数', exact: true }).click();
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.getByRole('button', { name: '关于与诊断', exact: true }).click();
  const scroller = page.locator('.settings-scroll');
  expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  expect(
    await scroller.evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar').width),
  ).toBe('8px');
});

test('skills and knowledge are independent settings sections', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '技能', exact: true }).click();
  await expect(page.getByText('Corax 原生技能', { exact: true })).toBeVisible();
  await expect(page.getByText('文本来源', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await expect(page.getByText('文本来源', { exact: true })).toBeVisible();
  await expect(page.getByText('SQLite 资料包', { exact: true })).toBeVisible();
  await expect(page.getByText('Corax 原生技能', { exact: true })).toHaveCount(0);
});

test('missing device capability disables instrument navigation without querying unavailable routes', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await expect(page.getByRole('button', { name: '仪器', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__desktopTest.deviceSnapshotReads ?? 0)).toBe(0);
});

test('the whole chat process keeps intermediate text, skill loading and tool results after completion and history reload', async ({
  page,
}, testInfo) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('textbox', { name: '输入消息' }).fill('保留全部处理过程');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: '处理过程', exact: true }).click();
  await expect(page.getByText('我先加载技能并读取参考资料。', { exact: true })).toBeVisible();
  await expect(page.getByText('加载 Skill', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-tool[data-call-id="read-1"] summary')).toBeVisible();
  const skill = page.locator('.chat-tool').filter({ hasText: '加载 Skill' });
  await skill.locator('summary').first().click();
  await expect(skill.getByText('技能已加载：hello-world', { exact: true })).toBeVisible();
  await expect(skill.locator('pre').first()).toContainText('"name": "hello-world"');
  await page.getByRole('button', { name: '开启新对话', exact: true }).click();
  await page.getByRole('button', { name: /BET 方法咨询/ }).click();
  await page.getByRole('button', { name: '处理过程', exact: true }).click();
  await expect(page.getByText('加载 Skill', { exact: true })).toBeVisible();
  await expect(page.getByText('我先加载技能并读取参考资料。', { exact: true })).toBeVisible();
  const read = page.locator('.chat-tool[data-call-id="read-1"]');
  await read.locator('summary').first().click();
  await expect(read.getByText('参考资料已读取，气体为 N₂。', { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('complete-conversation-process.png'),
    animations: 'disabled',
  });
  expect(await page.evaluate(() => (window as any).__desktopTest.submissions)).toBe(1);
});

test('Corax chat connects using the native conversation capabilities', async ({ page }) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    (window as any).__desktopTest.capabilities = {
      sessions: { create: true, send: true, history: true, cancel: true },
      messages: { text: true, reasoning: true, toolCalls: true },
      events: { notifications: true, snapshot: true },
    };
  });
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await expect(page.getByRole('button', { name: '运行图', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '输入消息' })).toBeEnabled();
});

test('desktop rejects a backend that does not implement the required protocol', async ({
  page,
}) => {
  await mockDesktop(page, { invalidProtocol: true });
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'disconnected');
  await expect(page.getByRole('alert')).toContainText('前后端接口协议不一致');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试启动', exact: true })).toBeVisible();
});

test('completed Corax reasoning survives history reload without submitting work', async ({
  page,
}, testInfo) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('textbox', { name: '输入消息' }).fill('介绍 BET');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: '处理过程', exact: true }).click();
  await page.locator('.chat-thinking > button').click();
  await expect(page.getByText('先查阅资料，再整理结论。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '开启新对话', exact: true }).click();
  await page.getByRole('button', { name: /BET 方法咨询/ }).click();
  await page.getByRole('button', { name: '处理过程', exact: true }).click();
  await page.locator('.chat-thinking > button').click();
  await expect(page.getByText('先查阅资料，再整理结论。', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'LangGraph 节点拓扑' })).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('corax-reasoning-history.png'),
    animations: 'disabled',
  });
  expect(await page.evaluate(() => (window as any).__desktopTest.submissions)).toBe(1);
});
test('panel transitions leave the left workspace stationary and animate only right content', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  const result = await page.evaluate(async () => {
    const sidebar = document.querySelector('.session-sidebar')!;
    const before = sidebar.getBoundingClientRect();
    document
      .querySelector('.navigation-rail button[aria-label="设置"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await new Promise(requestAnimationFrame);
    const pageAnimating = document.querySelector('.view-host')!.getAnimations().length > 0;
    const samples = [];
    for (let i = 0; i < 8; i++) {
      await new Promise(requestAnimationFrame);
      const rect = sidebar.getBoundingClientRect();
      samples.push({
        x: rect.x,
        y: rect.y,
        transform: getComputedStyle(sidebar).transform,
        animations: sidebar.getAnimations().length,
      });
    }
    document
      .querySelector('button[aria-label="切换会话列表"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await new Promise(requestAnimationFrame);
    const main = document.querySelector('.main-area')!;
    const movement = main.getAnimations()[0];
    const visibility = sidebar.getAnimations()[0];
    movement?.pause();
    visibility?.pause();
    if (movement) movement.currentTime = 110;
    if (visibility) visibility.currentTime = 110;
    await new Promise(requestAnimationFrame);
    const matrix = new DOMMatrix(getComputedStyle(main).transform);
    const during = {
      visibility: getComputedStyle(sidebar).visibility,
      opacity: getComputedStyle(sidebar).opacity,
      x: sidebar.getBoundingClientRect().x,
      scaleX: matrix.a,
      translateX: matrix.e,
      covered: main.contains(document.elementFromPoint(before.right - 5, before.top + 100)),
    };
    movement?.finish();
    visibility?.finish();
    await new Promise(requestAnimationFrame);
    return {
      before: { x: before.x, y: before.y },
      samples,
      pageAnimating,
      sidebarTransform: getComputedStyle(sidebar).transform,
      during,
      sidebarHiddenAfter: getComputedStyle(sidebar).visibility === 'hidden',
      contentAnimating: !!movement,
    };
  });
  expect(result.pageAnimating).toBe(true);
  expect(result.contentAnimating).toBe(true);
  expect(result.sidebarTransform).toBe('none');
  expect(result.during.visibility).toBe('visible');
  expect(result.during.opacity).toBe('1');
  expect(result.during.x).toBe(result.before.x);
  expect(result.during.scaleX).toBe(1);
  expect(result.during.translateX).toBeGreaterThan(0);
  expect(result.during.covered).toBe(true);
  expect(result.sidebarHiddenAfter).toBe(true);
  for (const sample of result.samples)
    expect(sample).toEqual({ ...result.before, transform: 'none', animations: 0 });
});

test('sidebar opening and closing keep the right edge covered throughout the transition', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  const frames = await page.evaluate(async () => {
    const main = document.querySelector('.main-area')!;
    const sidebar = document.querySelector('.session-sidebar')!;
    const right = main.getBoundingClientRect().right;
    const left = sidebar.getBoundingClientRect().left;
    const result = [];
    for (let direction = 0; direction < 2; direction++) {
      document
        .querySelector('button[aria-label="切换会话列表"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      await new Promise(requestAnimationFrame);
      const animation = main.getAnimations()[0];
      animation.pause();
      for (const time of [0, 55, 110, 165, 219]) {
        animation.currentTime = time;
        await new Promise(requestAnimationFrame);
        const bounds = main.getBoundingClientRect();
        result.push({
          gap: Math.abs(bounds.right - right),
          sidebarDelta: Math.abs(sidebar.getBoundingClientRect().left - left),
          covered: main.contains(document.elementFromPoint(right - 3, bounds.top + 100)),
          scaleX: new DOMMatrix(getComputedStyle(main).transform).a,
        });
      }
      animation.finish();
      await new Promise(requestAnimationFrame);
    }
    return result;
  });
  for (const frame of frames) {
    expect(frame.gap).toBeLessThan(1);
    expect(frame.sidebarDelta).toBe(0);
    expect(frame.covered).toBe(true);
    expect(frame.scaleX).toBe(1);
  }
});

test('custom window controls and sidebar remain independent of chat actions', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索会话' })).toBeVisible();
  await page.getByRole('button', { name: '最大化窗口' }).click();
  await expect(page.getByRole('button', { name: '还原窗口' })).toBeVisible();
  await page.getByRole('button', { name: '还原窗口' }).click();
  await page.getByRole('button', { name: '最小化窗口' }).click();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.getByRole('button', { name: '切换会话列表' }).click();
  await expect(page.getByRole('searchbox', { name: '搜索会话' })).toHaveCount(0);
  const data = await page.evaluate(() => (window as any).__desktopTest);
  expect(data.windowActions).toEqual(
    expect.arrayContaining(['toggle-maximize', 'minimize', 'close']),
  );
  expect(data.submissions).toBe(0);
  expect(
    await page
      .locator('img')
      .evaluateAll((images) =>
        images.every((image) => !(image as HTMLImageElement).src.includes('/docs/')),
      ),
  ).toBe(true);
});
test('welcome design, FAQ selection, one submission and streamed Markdown response', async ({
  page,
}, testInfo) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await expect(page.getByRole('button', { name: '退出应用' })).toHaveCount(0);
  await expect(page.getByText('本地服务已连接')).toHaveCount(0);
  await expect(page.getByText('让每一次测样更从容')).toHaveCount(0);
  await expect(page.getByText('Enter 发送 · Shift + Enter 换行')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '常见问题' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('welcome.png'), fullPage: true });
  await page.getByRole('button', { name: 'BET 比表面积和 BJH 孔径分析有什么区别？' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'N₂' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.submissions)).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('conversation.png'), fullPage: true });
});
test('settings use real configuration names and do not persist credentials in local storage', async ({
  page,
}, testInfo) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型连接' })).toBeVisible();
  await page.getByLabel('模型名称', { exact: false }).fill('test-model');
  await page.getByPlaceholder('输入你的 API Key').fill('local-ui-test-key');
  await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.saves.some(
          (entry: any) => entry.apiKey === 'local-ui-test-key',
        ),
      ),
    )
    .toBe(true);
  await expect(page.getByRole('button', { name: '保存更改' })).toHaveCount(0);
  await expect(page.getByText('有未保存的更改')).toHaveCount(0);
  const data = await page.evaluate(() => ({
    saves: (window as any).__desktopTest.saves,
    storage: JSON.stringify(localStorage),
  }));
  const savedKey = data.saves.find((entry: any) => entry.apiKey === 'local-ui-test-key');
  expect(savedKey.settings.model).toBe('test-model');
  expect(savedKey.settings.apiKey).toBeUndefined();
  expect(savedKey.configRevision).toBe('test-revision');
  await expect(page.getByText('已保存的凭据', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '移除 Key', exact: true })).toHaveCount(0);
  expect(data.storage).not.toContain('local-ui-test-key');
  await expect(page.getByRole('button', { name: '设备连接', exact: true })).toHaveCount(0);
});

test('shared config conflicts keep the draft until explicit reload', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const model = page.getByLabel('模型名称', { exact: false });
  await expect(model).toHaveValue('deepseek-flash');
  await page.evaluate(() => {
    (window as any).__desktopTest.externalModel = 'edited-by-cli';
  });
  await model.fill('desktop-draft');
  await expect(page.getByRole('alert')).toContainText('共享配置已被外部修改');
  await expect(model).toHaveValue('desktop-draft');
  expect(await page.evaluate(() => (window as any).__desktopTest.saves.length)).toBe(0);
  await page.getByRole('button', { name: '重新读取配置' }).click();
  await expect(model).toHaveValue('edited-by-cli');
  await model.fill('shared-model');
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.saves.length)).toBe(1);
  await page.getByRole('button', { name: '关于与诊断', exact: true }).click();
  await expect(page.getByText('C:\\DesktopTest\\config.json', { exact: true })).toBeVisible();
});

test('configured API Key shows a mask, preserves credentials on other edits and supports replacement', async ({
  page,
}) => {
  await mockDesktop(page, { hasApiKey: true });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const input = page.getByLabel('API Key', { exact: true });
  await expect(input).toHaveValue('••••••••••••');
  await expect(input).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: '显示 Key', exact: true })).toHaveCount(0);
  await page.getByLabel('模型名称', { exact: false }).fill('changed-model');
  await expect.poll(() => page.evaluate(() => (window as any).__desktopTest.saves.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__desktopTest.saves[0].apiKey)).toBeNull();
  await expect(page.getByRole('button', { name: '更换 API Key' })).toHaveCount(0);
  await input.click();
  await expect(input).toBeEditable();
  await expect(input).toHaveValue('');
  await input.fill('replacement-test-key');
  await expect(input).toHaveValue('••••••••••••');
  expect(await page.evaluate(() => (window as any).__desktopTest.saves.at(-1).apiKey)).toBe(
    'replacement-test-key',
  );
  expect(
    await page.evaluate(() => JSON.stringify((window as any).__desktopTest.saves)),
  ).not.toContain('••••');
});

test('environment API Key displays configured state without a misleading reveal or edit control', async ({
  page,
}) => {
  await mockDesktop(page, { hasApiKey: true, apiKeySource: 'environment' });
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('••••••••••••');
  await expect(
    page.getByText('已配置 · 来自 AUTO_AGENT_API_KEY 环境变量，与 CLI 一致。'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '更换 API Key' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '显示 Key', exact: true })).toHaveCount(0);
});

test('settings replace the conversation sidebar, search categories and respect reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: '搜索设置' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索会话' })).toHaveCount(0);
  await page.getByRole('searchbox', { name: '搜索设置' }).fill('Token');
  await expect(page.getByRole('button', { name: '运行参数', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '模型连接', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '运行参数', exact: true }).click();
  await expect(page.getByLabel('输入 Token 容量', { exact: true })).toBeVisible();
  expect(
    await page.locator('.settings-scroll').evaluate((element) => element.getAnimations().length),
  ).toBe(0);
  await page.getByRole('button', { name: '返回聊天' }).click();
  await page.getByRole('button', { name: '切换会话列表' }).click();
  await page.getByRole('button', { name: '切换会话列表' }).click();
  await expect(page.getByRole('searchbox', { name: '搜索会话' })).toBeVisible();
});

test('settings auto-save across navigation without confirmation and keyboard navigation is instant', async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.keyboard.press('Control+,');
  await expect(page.getByLabel('模型名称', { exact: true })).toBeVisible();
  await page.getByLabel('模型名称', { exact: true }).fill('unsaved-model');
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: '聊天主页' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.saves.some(
          (entry: any) => entry.settings.model === 'unsaved-model',
        ),
      ),
    )
    .toBe(true);
  expect(dialogs).toEqual([]);
  await expect(page.getByRole('heading', { name: '随时可以开始。' })).toBeVisible();
  await page.keyboard.press('Control+b');
  expect(await page.locator('main').evaluate((element) => element.getAnimations().length)).toBe(0);
  await page.keyboard.press('Control+b');
  await expect(page.getByRole('searchbox', { name: '搜索会话' })).toBeVisible();
});
