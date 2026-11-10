import { test, expect, type Page } from '@playwright/test';

async function nativeDesktop(
  page: Page,
  existing = false,
  suggestionMode: 'ready' | 'hold' | 'fail' = 'ready',
) {
  const initialize = ({
    existing,
    suggestionMode,
  }: {
    existing: boolean;
    suggestionMode: string;
  }) => {
    (window as any).isTauri = true;
    const callbacks: Record<number, (value: unknown) => void> = {};
    const listeners: Record<number, { event: string; handler: number }> = {};
    const sessionId = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    const records: any[] = [];
    const secondId = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TC';
    const histories: Record<string, any[]> = { [sessionId]: records };
    const testState = {
      requests: [] as string[],
      rejectSend: false,
      dialogs: [] as any[],
      saves: [] as any[],
      timings: [] as any[],
      activeView: '',
      activeWatch: '',
      viewCalls: [] as any[],
      watchRequests: [] as any[],
      holdHistoryFor: '',
      cancelledHistory: 0,
      generation: '00000000-0000-4000-8000-000000000001',
      corruptSuffix: false,
      failHistory: false,
      holdList: false,
      knowledgeStarts: [] as any[],
      knowledgePageRequests: [] as string[],
      knowledgeUncertain: false,
      knowledgeReject: false,
      knowledgeConfigRevision: 'revision',
      pendingSettingsApply: false,
      suggestionRequests: 0,
      updateInstallCalls: 0,
      suggestionFailure: suggestionMode === 'fail',
      holdSuggestions: suggestionMode === 'hold',
      suggestions: [
        '多孔碳材料测试前应如何核对样品条件？',
        '如何选择适合当前材料的吸附测试模板？',
        '如何比较已有 SAM 文件的参数差异？',
        '如何查看材料测试资料的原文来源？',
      ],
    };
    const heldHistory = new Map<string, () => void>();
    const releaseHistory = new Map<string, () => void>();
    const releaseList: (() => void)[] = [];
    const releaseSuggestions: (() => void)[] = [];
    const releaseUpdate: (() => void)[] = [];
    let knowledgeOperation: any = null;
    let knowledgeDone = 0;
    (window as any).__desktopTest = testState;
    let next = 0,
      watchId = '',
      submitted = false;
    const settings = {
      dataDir: 'C:/isolated',
      model: 'local',
      baseURL: 'http://127.0.0.1/v1',
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
      systemPrompt: '',
      llmWiki: { sources: [] as { id: string; type: 'file' | 'directory'; path: string }[] },
      climber: { enabled: true, serviceURL: 'http://127.0.0.1:18080/api/v1', timeoutMs: 5000 },
    };
    const emit = (event: string, payload: unknown) => {
      for (const [id, listener] of Object.entries(listeners))
        if (listener.event === event)
          callbacks[listener.handler]?.({ event, id: Number(id), payload });
    };
    (window as any).__desktopFixture = {
      histories,
      emit,
      releaseHistory: () => {
        testState.holdHistoryFor = '';
        for (const release of releaseHistory.values()) release();
      },
      releaseList: () => {
        testState.holdList = false;
        for (const release of releaseList.splice(0)) release();
      },
      releaseSuggestions: () => {
        testState.holdSuggestions = false;
        for (const release of releaseSuggestions.splice(0)) release();
      },
      checkUpdateBackend: () => emit('update-stage', 'checking'),
      failUpdateBackend: () => {
        for (const release of releaseUpdate.splice(0)) release();
      },
      finishKnowledge: (state = 'completed', completed = 1) => {
        knowledgeDone = completed;
        knowledgeOperation = {
          ...knowledgeOperation,
          state,
          completed,
          pageCount: completed ? 2 : 0,
          finishedAt: new Date().toISOString(),
          ...(state !== 'completed' ? { message: '本次未全部完成，已发布的内容保留。' } : {}),
        };
      },
    };
    const append = (type: string, data: unknown) =>
      records.push({
        type,
        data,
        meta: {
          id: `event-${records.length}`,
          at: new Date(1800000000000 + records.length * 100).toISOString(),
        },
      });
    if (existing) {
      append('session.started', {});
      append('turn.started', { turnId: 'turn-1', sequence: 0 });
      append('message.received', { turnId: 'turn-1', sequence: 0, message: '会话一的问题' });
      append('message.completed', {
        turnId: 'turn-1',
        sequence: 0,
        stepIndex: 0,
        message: '会话一的回复',
        finishReason: 'stop',
      });
      append('turn.completed', { turnId: 'turn-1', sequence: 0 });
      histories[secondId] = structuredClone(records).map((event) => ({
        ...event,
        data: {
          ...event.data,
          ...(typeof event.data.message === 'string'
            ? { message: event.data.message.replace('一', '二') }
            : {}),
        },
      }));
    }
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback(fn: (value: unknown) => void) {
        callbacks[++next] = fn;
        return next;
      },
      unregisterCallback(id: number) {
        delete callbacks[id];
      },
      async invoke(command: string, args: any) {
        if (command === 'frontend_debug') {
          testState.timings.push(args);
          return;
        }
        if (command === 'update_check')
          return { channel: 'beta', version: '2.0.0-beta.3', notes: '隔离更新说明' };
        if (command === 'update_install') {
          testState.updateInstallCalls++;
          emit('update-progress', { downloaded: 1024, total: 2048 });
          await new Promise<void>((resolve) => releaseUpdate.push(resolve));
          throw new Error(
            '安装包已下载并通过签名校验，但无法安全停止后台：读取 Corax 状态超时。尚未启动安装。',
          );
        }
        if (command === 'plugin:dialog|open') {
          testState.dialogs.push(args.options);
          return args.options.directory ? 'C:\\fixtures\\knowledge' : 'C:\\fixtures\\notes.md';
        }
        if (command === 'plugin:event|listen') {
          const id = ++next;
          listeners[id] = { event: args.event, handler: args.handler };
          return id;
        }
        if (command === 'plugin:event|unlisten') {
          delete listeners[args.eventId];
          return;
        }
        if (command === 'backend_start') return { ready: true };
        if (command === 'backend_chat_open') {
          testState.viewCalls.push({ command, ...args });
          testState.activeView = args.viewId;
          testState.activeWatch = '';
          return;
        }
        if (command === 'backend_chat_close') {
          testState.viewCalls.push({ command, ...args });
          if (testState.activeView === args.viewId) {
            testState.activeView = '';
            testState.activeWatch = '';
            heldHistory.get(args.viewId)?.();
          }
          return;
        }
        if (command === 'window_action') return { maximized: false };
        if (command === 'settings_read')
          return {
            settings,
            defaults: {
              climber: {
                enabled: true,
                serviceURL: 'http://127.0.0.1:18080/api/v1',
                timeoutMs: 5000,
              },
            },
            configPath: 'C:\\isolated\\config.json',
            configRevision: 'revision',
            hasApiKey: false,
            dataDirectory: 'C:\\isolated',
            version: '2.0.0-beta.1',
          };
        if (command === 'settings_save') {
          testState.saves.push(structuredClone(args.settings));
          Object.assign(settings, args.settings);
          return {
            saved: true,
            applied: !testState.pendingSettingsApply,
            configRevision: 'revision',
          };
        }
        if (command === 'backend_watch') {
          if (args.viewId !== testState.activeView) throw new Error('会话视图已切换');
          testState.watchRequests.push(args);
          testState.activeWatch = args.sessionId;
          watchId = args.watchId;
          const target = args.sessionId;
          const watching = args.watchId;
          setTimeout(
            () =>
              emit('corax-events', {
                sessionId: target,
                watchId: watching,
                startIndex: args.startIndex,
                events: (histories[target] ?? []).slice(args.startIndex),
              }),
            0,
          );
          return;
        }
        if (command === 'backend_request') {
          testState.requests.push(args.path);
          if (args.path === '/suggestions') {
            testState.suggestionRequests++;
            const questions = [...testState.suggestions];
            if (testState.holdSuggestions)
              await new Promise<void>((resolve) => releaseSuggestions.push(resolve));
            if (testState.suggestionFailure) throw new Error('本地模拟模型不可用');
            return { source: 'model', questions };
          }
          const knowledgePage = {
            path: 'concepts/notes.md',
            title: '整理后的笔记',
            type: 'concept',
            summary: '保留来源的知识页',
            reference: {
              generation: '00000000-0000-4000-8000-000000000099',
              path: 'concepts/notes.md',
              sha256: 'a'.repeat(64),
            },
          };
          const knowledgeState = () => ({
            generation: testState.generation,
            configRevision: testState.knowledgeConfigRevision,
            operation: knowledgeOperation,
            admissionUncertain: testState.knowledgeUncertain,
          });
          if (args.path === '/knowledge')
            return {
              ...knowledgeState(),
              published: knowledgeDone > 0,
              publication: knowledgeDone ? knowledgePage.reference.generation : undefined,
              pageCount: knowledgeDone ? 2 : 0,
              wikiDirectory: knowledgeDone
                ? 'C:\\isolated\\llm-wiki\\.state\\generations\\fixture\\wiki'
                : undefined,
              sources: settings.llmWiki.sources.map((source, index) => ({
                id: source.id,
                status: index < knowledgeDone ? 'ready' : 'pending',
                documents: 1,
                ready: index < knowledgeDone ? 1 : 0,
                pageCount: index < knowledgeDone ? 1 : 0,
              })),
              pages: knowledgeDone ? [knowledgePage] : [],
              nextOffset: knowledgeDone ? 20 : null,
            };
          if (args.path.startsWith('/knowledge/pages?')) {
            testState.knowledgePageRequests.push(args.path);
            if (
              new URLSearchParams(args.path.split('?')[1]).get('generation') !==
              knowledgePage.reference.generation
            )
              throw new Error('测试目录版本不匹配');
            return {
              pages: [
                {
                  ...knowledgePage,
                  path: 'concepts/extra.md',
                  title: '额外知识页',
                  reference: { ...knowledgePage.reference, path: 'concepts/extra.md' },
                },
              ],
              nextOffset: null,
            };
          }
          if (args.path === '/knowledge/operation') return knowledgeState();
          if (args.path === '/knowledge/ingest') {
            testState.knowledgeStarts.push(args.body);
            if (testState.knowledgeReject) {
              testState.knowledgeUncertain = true;
              throw { message: '整理受理结果未知', admission: 'unknown' };
            }
            knowledgeOperation = {
              id: '00000000-0000-4000-8000-000000000010',
              state: 'running',
              phase: 'analysis',
              total: args.body.sourceId ? 1 : settings.llmWiki.sources.length,
              completed: 0,
              reused: 0,
              pageCount: 0,
              startedAt: new Date().toISOString(),
            };
            return knowledgeState();
          }
          if (args.path === '/knowledge/cancel') {
            knowledgeOperation = { ...knowledgeOperation, state: 'cancelling' };
            return knowledgeState();
          }
          if (args.path === '/knowledge/read')
            return {
              reference: knowledgePage.reference,
              title: knowledgePage.title,
              text: args.body.offset
                ? '后续内容也保留来源。'
                : '# 整理后的笔记\n这是有来源的知识正文。',
              startLine: args.body.offset ? 61 : 1,
              endLine: args.body.offset ? 62 : 60,
              nextOffset: args.body.offset ? null : 60,
            };
          if (args.path === '/capabilities')
            return {
              skills: [
                {
                  name: 'device-automation',
                  description: '仪器操作方法',
                  source: 'application',
                  builtIn: true,
                },
                {
                  name: 'runtime-discovered-skill',
                  description: '运行时发现的其他技能',
                  source: 'extension',
                  builtIn: false,
                },
              ],
              tools: [
                { name: 'wiki', description: '通用 Wiki', source: 'application', builtIn: true },
                {
                  name: 'sam_file',
                  description: '离线 SAM 文件工具',
                  source: 'application',
                  builtIn: true,
                },
              ],
              dynamicProviders: [],
              dynamicSkills: [],
            };
          if (args.path === '/global/health')
            return {
              healthy: true,
              protocolVersion: 4,
              engine: 'corax',
              version: '2.0.0-beta.1',
              capabilities: {
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
          if (args.path.startsWith('/session?')) {
            if (testState.holdList) await new Promise<void>((resolve) => releaseList.push(resolve));
            return existing
              ? [
                  { id: sessionId, title: '会话一', updatedAt: 1800000000001 },
                  { id: secondId, title: '会话二', updatedAt: 1800000000000 },
                ]
              : submitted
                ? [{ id: sessionId, title: '原生会话', updatedAt: 1800000000000 }]
                : [];
          }
          if (args.path === '/session' && args.method === 'POST') {
            return { id: sessionId, title: '新会话', updatedAt: 1800000000000 };
          }
          if (args.path.split('?')[0].endsWith('/events')) {
            const params = new URLSearchParams(args.path.split('?')[1]);
            let startIndex =
              params.get('generation') === testState.generation
                ? Number(params.get('startIndex') ?? 0)
                : 0;
            const target = args.path.split('/')[2];
            if (args.viewId !== testState.activeView) throw new Error('会话视图已切换');
            if (testState.failHistory) throw new Error('测试历史读取失败');
            if (testState.holdHistoryFor === target)
              await new Promise<void>((resolve, reject) => {
                releaseHistory.set(args.viewId, () => {
                  heldHistory.delete(args.viewId);
                  releaseHistory.delete(args.viewId);
                  resolve();
                });
                heldHistory.set(args.viewId, () => {
                  heldHistory.delete(args.viewId);
                  releaseHistory.delete(args.viewId);
                  testState.cancelledHistory++;
                  reject(new Error('会话视图已切换'));
                });
              });
            const history = histories[target] ?? [];
            if (testState.corruptSuffix && startIndex > 0) {
              startIndex++;
              testState.corruptSuffix = false;
            }
            return {
              sessionId: target,
              startIndex,
              revision: startIndex + history.slice(startIndex).length,
              generation: testState.generation,
              admitted: false,
              events: structuredClone(history.slice(startIndex)),
            };
          }
          if (args.path.endsWith('/prompt_async')) {
            if (testState.rejectSend)
              throw {
                code: 'session_not_ready',
                admission: 'rejected',
                message: '会话仍在准备中，本次消息尚未受理，请稍后发送。',
              };
            submitted = true;
            const startIndex = records.length;
            append('session.started', {});
            append('turn.started', { turnId: 'turn-1', sequence: 0 });
            append('message.received', {
              turnId: 'turn-1',
              sequence: 0,
              message: args.body.content,
            });
            append('message.appended', {
              turnId: 'turn-1',
              sequence: 0,
              stepIndex: 0,
              messageDelta: 'Corax 原生连接成功。',
            });
            append('message.completed', {
              turnId: 'turn-1',
              sequence: 0,
              stepIndex: 0,
              message: 'Corax 原生连接成功。',
              finishReason: 'stop',
            });
            append('turn.completed', { turnId: 'turn-1', sequence: 0 });
            append('session.waiting', { continuationToken: sessionId, wait: 'next-user-message' });
            setTimeout(() => {
              emit('corax-events', {
                sessionId,
                watchId,
                startIndex,
                events: structuredClone(records.slice(startIndex)),
              });
              emit('agent-event', { sessionId, type: 'session.updated', properties: {} });
            }, 30);
            return { ok: true, sessionId };
          }
        }
      },
    };
  };
  await page.addInitScript(initialize, { existing, suggestionMode });
}

test('welcome recommendations update silently without blocking input or creating a chat', async ({
  page,
}) => {
  await nativeDesktop(page, false, 'hold');
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.suggestionRequests))
    .toBe(1);
  await expect(page.getByRole('heading', { name: '为你推荐' })).toBeVisible();
  await expect(page.locator('.faq-item')).toHaveCount(0);
  await expect(page.getByText(/正在根据最近使用情况|暂时无法生成个性化推荐/)).toHaveCount(0);
  await page.getByRole('textbox', { name: '输入消息' }).fill('尚未发送的草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__desktopFixture.releaseSuggestions());
  await expect(page.getByRole('heading', { name: '为你推荐' })).toBeVisible();
  const question = page.getByRole('button', { name: '多孔碳材料测试前应如何核对样品条件？' });
  await expect(question).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).__desktopTest.requests.filter(
        (path: string) => path === '/session' || path.endsWith('/prompt_async'),
      ),
    ),
  ).toEqual([]);
  await question.click();
  await expect(page.getByText('Corax 原生连接成功。', { exact: true })).toBeVisible();
});

test('recommendation failure silently retains usable starter questions and does not retry on typing', async ({
  page,
}) => {
  await nativeDesktop(page, false, 'fail');
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.suggestionRequests))
    .toBe(1);
  await expect(page.locator('.faq-list')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('heading', { name: '为你推荐' })).toBeVisible();
  await expect(page.locator('.faq-item')).toHaveCount(4);
  await expect(page.getByText(/正在根据最近使用情况|无法生成个性化|模型不可用/)).toHaveCount(0);
  await page.getByRole('textbox', { name: '输入消息' }).fill('保持草稿可编辑');
  expect(await page.evaluate(() => (window as any).__desktopTest.suggestionRequests)).toBe(1);
});

test('returning to a new chat refreshes usage-based recommendations and ignores an old page response', async ({
  page,
}) => {
  await nativeDesktop(page, true, 'hold');
  await page.goto('/');
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.suggestionRequests))
    .toBe(1);
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.suggestions[0] = '如何核对最近讨论的氧化铝材料测试方法？';
  });
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.suggestionRequests))
    .toBe(2);
  await page.evaluate(() => (window as any).__desktopFixture.releaseSuggestions());
  await expect(
    page.getByRole('button', { name: '如何核对最近讨论的氧化铝材料测试方法？' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '多孔碳材料测试前应如何核对样品条件？' }),
  ).toHaveCount(0);
});

test('new chats reuse recommendations in their first DOM frame and retain them after a failed refresh', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  const previous = '多孔碳材料测试前应如何核对样品条件？';
  await expect(page.getByRole('button', { name: previous })).toBeVisible();
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.holdSuggestions = true;
    (window as any).__desktopTest.suggestionFailure = true;
    const frames: { heading: string; questions: string[] }[] = [];
    (window as any).__welcomeFrames = frames;
    const observer = new MutationObserver(() => {
      const card = document.querySelector('.faq-card');
      if (card)
        frames.push({
          heading: card.querySelector('h2')?.textContent ?? '',
          questions: [...card.querySelectorAll('.faq-item span')].map(
            (item) => item.textContent ?? '',
          ),
        });
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    (window as any).__welcomeObserver = observer;
  });
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(page.getByRole('button', { name: previous })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.suggestionRequests))
    .toBe(2);
  await page.evaluate(() => (window as any).__desktopFixture.releaseSuggestions());
  await expect(page.locator('.faq-list')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: previous })).toBeVisible();
  const frames = await page.evaluate(() => {
    (window as any).__welcomeObserver.disconnect();
    return (window as any).__welcomeFrames as { heading: string; questions: string[] }[];
  });
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.heading).toBe('为你推荐');
    expect(frame.questions).toHaveLength(4);
    expect(frame.questions[0]).toBe(previous);
  }
});

test('reconnection drops previous recommendation identity before displaying replacement questions', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  const previous = '多孔碳材料测试前应如何核对样品条件？';
  await expect(page.getByRole('button', { name: previous })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.holdSuggestions = true;
    (window as any).__desktopTest.suggestions[0] = '新数据目录中的资料应该如何核对来源？';
    (window as any).__desktopFixture.emit('backend-stream', 'disconnected');
  });
  await expect(page.getByRole('button', { name: previous })).toHaveCount(0);
  await page.evaluate(() => (window as any).__desktopFixture.emit('backend-stream', 'connected'));
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.suggestionRequests))
    .toBe(2);
  await expect(page.getByRole('button', { name: previous })).toHaveCount(0);
  await page.evaluate(() => (window as any).__desktopFixture.releaseSuggestions());
  await expect(
    page.getByRole('button', { name: '新数据目录中的资料应该如何核对来源？' }),
  ).toBeVisible();
});

test('native event records project into the conversation without a Node HTTP bridge', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('textbox', { name: '输入消息' }).fill('验证原生连接');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Corax 原生连接成功。', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.timings.some(
          (entry: any) => entry.operation === 'send' && entry.stage === 'end',
        ),
      ),
    )
    .toBe(true);
  const timings = await page.evaluate(() => (window as any).__desktopTest.timings);
  expect(JSON.stringify(timings)).not.toContain('验证原生连接');
  expect(JSON.stringify(timings)).not.toContain('wrun_');
  for (const entry of timings)
    for (const value of Object.values(entry.details))
      expect(['number', 'boolean']).toContain(typeof value);
  await expect(page.getByRole('button', { name: '仪器', exact: true })).toBeDisabled();
});

test('accepted sends stop submitting feedback while history sync still gates writes and list refresh is independent', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  const send = page.getByRole('button', { name: '发送消息', exact: true });
  await page.getByRole('textbox', { name: '输入消息' }).fill('检查受理后的等待');
  await expect(send).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__desktopTest.holdHistoryFor = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    (window as any).__desktopTest.holdList = true;
  });
  await send.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.timings.some(
          (entry: any) => entry.operation === 'send' && entry.stage === 'accepted',
        ),
      ),
    )
    .toBe(true);
  await expect(page.locator('.chat-activity').filter({ hasText: '正在提交' })).toHaveCount(0);
  await expect(send).toBeDisabled();
  await page.evaluate(() => (window as any).__desktopFixture.releaseHistory());
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.timings.some(
          (entry: any) => entry.operation === 'send' && entry.stage === 'end',
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('textbox', { name: '输入消息' }).fill('列表仍在刷新时的草稿');
  await expect(send).toBeEnabled();
  await page.evaluate(() => (window as any).__desktopFixture.releaseList());
});

test('current settings edit one canonical configuration', async ({ page }) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('模型名称', { exact: false })).toHaveValue('local');
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await expect(
    page.locator('.settings-menu').getByRole('button', { name: '仪器', exact: true }),
  ).toBeVisible();
  await page.locator('.settings-menu').getByRole('button', { name: '仪器', exact: true }).click();
  const manufacturerURL = page.getByLabel('厂家接口地址', { exact: true });
  const enabled = page.getByLabel('启用设备连接', { exact: true });
  await expect(manufacturerURL).toHaveValue('http://127.0.0.1:18080/api/v1');
  await expect(enabled).toBeChecked();
  await enabled.uncheck();
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.saves.at(-1)?.climber.enabled))
    .toBe(false);
  await manufacturerURL.fill('');
  await enabled.check();
  await expect(manufacturerURL).toHaveValue('http://127.0.0.1:18080/api/v1');
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.saves.at(-1)?.climber))
    .toEqual({ enabled: true, serviceURL: 'http://127.0.0.1:18080/api/v1', timeoutMs: 5000 });
  await page.getByRole('button', { name: '用户知识库', exact: true }).click();
  await expect(page.getByText('资料来源', { exact: true })).toBeVisible();
  await expect(page.getByText('SQLite 资料包', { exact: true })).toHaveCount(0);
});

test('update UI distinguishes download progress from backend verification failure without claiming an ambiguous write', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关于与诊断', exact: true }).click();
  await page.getByRole('button', { name: '检查更新', exact: true }).click();
  const install = page.getByRole('button', { name: '下载并安装 2.0.0-beta.3', exact: true });
  await install.click();
  await expect(page.locator('.maintenance-status')).toContainText('正在下载 50%');
  await expect(install).toBeDisabled();
  await page.evaluate(() => (window as any).__desktopFixture.checkUpdateBackend());
  await expect(page.locator('.maintenance-status')).toContainText(
    '安装包已下载并通过签名校验，正在确认后台任务状态',
  );
  await page.evaluate(() => (window as any).__desktopFixture.failUpdateBackend());
  await expect(page.locator('.maintenance-status')).toContainText('尚未启动安装');
  await expect(page.locator('.maintenance-status')).not.toContainText('不要重复提交');
  await expect(install).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__desktopTest.updateInstallCalls)).toBe(1);
});

test('settings show discovered skills and tools without built-in disable controls', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const navigation = page.locator('.settings-menu');
  await navigation.getByRole('button', { name: '技能', exact: true }).click();
  await expect(page.getByText('runtime-discovered-skill', { exact: true })).toBeVisible();
  await expect(page.getByText('device-automation', { exact: true })).toBeVisible();
  await expect(page.getByText('内置 · 不可禁用', { exact: true })).toHaveCount(1);
  await navigation.getByRole('button', { name: '工具', exact: true }).click();
  await expect(page.getByText('bash', { exact: true })).toHaveCount(0);
  await expect(page.getByText('wiki', { exact: true })).toBeVisible();
  await expect(page.getByText('sam_file', { exact: true })).toBeVisible();
  await expect(page.getByText('内置 · 不可禁用', { exact: true })).toHaveCount(2);
  await expect(page.locator('.settings-capability-list').getByRole('checkbox')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__desktopTest.saves.length)).toBe(0);
});

test('Wiki sources accept both text files and directories through the native picker', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '用户知识库', exact: true }).click();
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  await expect(page.getByText('C:\\fixtures\\notes.md', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '添加文件夹', exact: true }).click();
  await expect(page.getByText('C:\\fixtures\\knowledge', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.saves.at(-1)?.llmWiki.sources.map((entry: any) => entry.type),
      ),
    )
    .toEqual(['file', 'directory']);
  expect(
    await page.evaluate(() =>
      (window as any).__desktopTest.dialogs.map((options: any) => options.directory),
    ),
  ).toEqual([false, true]);
  await page
    .locator('.settings-menu')
    .getByRole('button', { name: '关于与诊断', exact: true })
    .click();
  await expect(page.locator('code[title="C:\\\\isolated\\\\config.json"]')).toHaveCount(1);
  await expect(page.getByText('C:\\isolated', { exact: true })).toBeVisible();
});

test('known admission rejection keeps the draft and does not claim the send outcome is unknown', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.evaluate(() => {
    (window as any).__desktopTest.rejectSend = true;
  });
  await page.getByRole('textbox', { name: '输入消息' }).fill('保留这条草稿');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(
    page.getByText('会话仍在准备中，本次消息尚未受理，请稍后发送。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('保留这条草稿');
  await expect(page.getByText('请先刷新会话状态确认是否已受理。', { exact: false })).toHaveCount(0);
});

test('adding a source does not compile until explicitly requested and generated pages remain readable after removing the source', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '用户知识库', exact: true }).click();
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  const start = page.getByRole('button', { name: '开始整理', exact: true });
  await expect(start).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts.length)).toBe(0);
  await expect(page.getByText('待整理', { exact: true })).toBeVisible();
  await start.click();
  await expect(page.getByText('分析资料', { exact: true })).toBeVisible();
  await page.locator('.settings-menu').getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '用户知识库', exact: true }).click();
  await expect(page.getByText('分析资料', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__desktopFixture.finishKnowledge('completed', 1));
  await expect(page.getByText('整理完成', { exact: true })).toBeVisible();
  await expect(page.getByText('已整理', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '显示更多知识页', exact: true }).click();
  await expect(page.getByRole('button', { name: /^额外知识页/ })).toBeVisible();
  expect(
    await page.evaluate(() =>
      new URLSearchParams((window as any).__desktopTest.knowledgePageRequests[0].split('?')[1]).get(
        'generation',
      ),
    ),
  ).toBe('00000000-0000-4000-8000-000000000099');
  await page.getByRole('button', { name: /^整理后的笔记/ }).click();
  await expect(page.getByText('这是有来源的知识正文。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续阅读', exact: true }).click();
  await expect(page.getByText('后续内容也保留来源。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '移除 C:\\fixtures\\notes.md', exact: true }).click();
  await expect(page.getByRole('button', { name: /^整理后的笔记/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts.length)).toBe(1);
});

test('cancelling knowledge compilation waits for a terminal result and reports completed publications', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '用户知识库', exact: true }).click();
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始整理', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '添加文件夹', exact: true }).click();
  const all = page.getByRole('button', { name: '整理全部资料', exact: true });
  await expect(all).toBeEnabled();
  await all.click();
  await page.getByRole('button', { name: '取消整理', exact: true }).click();
  await expect(page.getByText('正在取消，等待当前处理结束', { exact: true })).toBeVisible();
  await expect(all).toBeDisabled();
  await page.evaluate(() => (window as any).__desktopFixture.finishKnowledge('cancelled', 1));
  await expect(page.getByText('整理已取消', { exact: true })).toBeVisible();
  await expect(page.getByLabel('整理结果')).toContainText('已完成 1/2 份资料');
  await expect(page.getByRole('button', { name: /^整理后的笔记/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts.length)).toBe(1);
});

test('knowledge compilation waits for applied settings and never replays an uncertain start', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '用户知识库', exact: true }).click();
  await page.evaluate(() => {
    (window as any).__desktopTest.pendingSettingsApply = true;
  });
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  await expect(
    page.getByText('资料配置已保存，等待任务结束后生效。', { exact: true }),
  ).toBeVisible();
  const start = page.getByRole('button', { name: '开始整理', exact: true });
  await expect(start).toBeDisabled();
  await page.evaluate(() => {
    (window as any).__desktopTest.pendingSettingsApply = false;
    (window as any).__desktopTest.knowledgeConfigRevision = 'not-applied';
    (window as any).__desktopTest.knowledgeReject = true;
    (window as any).__desktopFixture.emit('settings-applied', { applied: true });
  });
  await expect(
    page.getByText('资料配置尚未在当前后端生效。外部修改配置后，请重启应用再刷新状态。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(start).toBeDisabled();
  await page.evaluate(() => {
    (window as any).__desktopTest.knowledgeConfigRevision = 'revision';
  });
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(
    page.getByText('整理请求结果尚未确认，未自动重试。请刷新并核对已发布内容。', { exact: true }),
  ).toBeVisible();
  await expect(start).toBeDisabled();
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts.length)).toBe(1);
});

test('refreshing the selected conversation requests an unread suffix rather than replaying history', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('textbox', { name: '输入消息' }).fill('第一条消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Corax 原生连接成功。', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息' }).fill('第二条消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.requests.some(
          (path: string) => Number(new URLSearchParams(path.split('?')[1]).get('startIndex')) > 0,
        ),
      ),
    )
    .toBe(true);
  await expect(page.getByText('第二条消息', { exact: true })).toBeVisible();
});

test('switching back shows cached history before the unread suffix is available and gates writes', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('会话一的回复', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    const fixture = (window as any).__desktopFixture;
    const id = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    state.holdHistoryFor = id;
    fixture.histories[id].push(
      ...[
        { type: 'turn.started', data: { turnId: 'turn-2', sequence: 1 } },
        {
          type: 'message.received',
          data: { turnId: 'turn-2', sequence: 1, message: '离开期间收到的新消息' },
        },
        { type: 'turn.completed', data: { turnId: 'turn-2', sequence: 1 } },
      ].map((event, index) => ({
        ...event,
        meta: { id: `event-${5 + index}`, at: '2026-11-07T00:00:00.000Z' },
      })),
    );
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('离开期间收到的新消息', { exact: true })).toHaveCount(0);
  await expect(page.locator('.chat-activity')).toHaveCount(0);
  await page.getByRole('textbox', { name: '输入消息' }).fill('同步前禁止发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '取消本次回复', exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as any).__desktopTest.requests.filter(
          (path: string) => path === '/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events',
        ).length,
    ),
  ).toBe(1);
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.requests.some((path: string) =>
          path.startsWith(
            '/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events?startIndex=5&generation=',
          ),
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => (window as any).__desktopFixture.releaseHistory());
  await expect(page.getByText('离开期间收到的新消息', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.getByText('会话一的回复', { exact: true })).toHaveCount(1);
  await expect(page.locator('.chat-activity')).toHaveCount(0);
  const state = await page.evaluate(() => (window as any).__desktopTest);
  expect(state.viewCalls.filter((call: any) => call.command === 'backend_chat_close').length).toBe(
    2,
  );
  expect(state.activeWatch).toBe('wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB');
});

test('switching away cancels a held history read and does not subscribe the stale view', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.evaluate(() => {
    (window as any).__desktopTest.holdHistoryFor = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('正在读取会话…', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.requests.some(
          (path: string) => path === '/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events',
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('会话一的回复', { exact: true })).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).__desktopTest.cancelledHistory))
    .toBe(1);
  const state = await page.evaluate(() => (window as any).__desktopTest);
  expect(state.watchRequests.map((request: any) => request.sessionId)).toEqual([
    'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TC',
  ]);
  await expect(page.getByText('会话视图已切换', { exact: false })).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__desktopTest.holdHistoryFor = '';
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
});

test('cached active turns do not enable cancellation before current-view synchronization', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.evaluate(() => {
    (window as any).__desktopFixture.histories['wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB'].pop();
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByRole('button', { name: '取消本次回复', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.holdHistoryFor = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '取消本次回复', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: '输入消息' }).fill('同步前禁止发送');
  await page.getByRole('textbox', { name: '输入消息' }).press('Enter');
  expect(
    await page.evaluate(() =>
      (window as any).__desktopTest.requests.filter(
        (path: string) => path.endsWith('/prompt_async') || path.endsWith('/abort'),
      ),
    ),
  ).toEqual([]);
  await page.evaluate(() => (window as any).__desktopFixture.releaseHistory());
  await expect(page.getByRole('button', { name: '取消本次回复', exact: true })).toBeVisible();
});

test('an incompatible suffix is discarded and rebuilt once from zero', async ({ page }) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.corruptSuffix = true;
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__desktopTest.requests.filter(
            (path: string) => path === '/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events',
          ).length,
      ),
    )
    .toBe(2);
  await expect(page.getByText('会话一的回复', { exact: true })).toHaveCount(1);
  await page.getByRole('textbox', { name: '输入消息' }).fill('已重建');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
});

test('failed synchronization retains cached display but requires a successful refresh before writing', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.failHistory = true;
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('测试历史读取失败', { exact: true })).toBeVisible();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息' }).fill('失败后保留草稿');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    (window as any).__desktopTest.failHistory = false;
  });
  await page.getByRole('button', { name: '刷新会话状态', exact: true }).click();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.getByText('会话一的回复', { exact: true })).toHaveCount(1);
});

test('a new generation replaces cached display even at a lower revision and drops other cached sessions', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.generation = '00000000-0000-4000-8000-000000000002';
    const events = (window as any).__desktopFixture.histories['wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB'];
    events.splice(3);
    events[2].data.message = '新代际的问题';
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('新代际的问题', { exact: true })).toBeVisible();
  await expect(page.getByText('会话一的回复', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__desktopTest.requests.filter(
            (path: string) => path === '/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TC/events',
          ).length,
      ),
    )
    .toBe(2);
});

test('reconnection clears cached history before reading the replacement backend', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopFixture.emit('backend-stream', 'connected');
    (window as any).__desktopTest.holdHistoryFor = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__desktopTest.watchRequests.filter((entry: any) =>
            entry.sessionId.endsWith('7TC'),
          ).length,
      ),
    )
    .toBe(2);
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__desktopTest.requests.filter(
            (path: string) => path === '/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events',
          ).length,
      ),
    )
    .toBe(2);
  await page.evaluate(() => (window as any).__desktopFixture.releaseHistory());
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
});
