import { test, expect, type Page } from '@playwright/test';

async function nativeDesktop(page: Page, existing = false) {
  const initialize = (existing: boolean) => {
    (window as any).isTauri = true;
    const callbacks: Record<number, (value: unknown) => void> = {};
    const listeners: Record<number, { event: string; handler: number }> = {};
    const sessionId = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    const records: any[] = [];
    const secondId = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TC';
    const histories: Record<string, any[]> = { [sessionId]: records };
    const testState = { requests: [] as string[], rejectSend: false };
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
      llmWiki: { sources: [] },
      climber: { enabled: false, serviceURL: '', timeoutMs: 5000 },
    };
    const emit = (event: string, payload: unknown) => {
      for (const [id, listener] of Object.entries(listeners))
        if (listener.event === event)
          callbacks[listener.handler]?.({ event, id: Number(id), payload });
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
        if (command === 'window_action') return { maximized: false };
        if (command === 'settings_read')
          return {
            settings,
            configPath: 'C:/isolated/config.json',
            configRevision: 'revision',
            hasApiKey: false,
            dataDirectory: 'C:/isolated/corax',
            version: '2.0.0-beta.1',
          };
        if (command === 'settings_save') {
          Object.assign(settings, args.settings);
          return { saved: true, applied: true, configRevision: 'revision' };
        }
        if (command === 'backend_watch') {
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
          if (args.path.startsWith('/session?'))
            return existing
              ? [
                  { id: sessionId, title: '会话一', updatedAt: 1800000000001 },
                  { id: secondId, title: '会话二', updatedAt: 1800000000000 },
                ]
              : submitted
                ? [{ id: sessionId, title: '原生会话', updatedAt: 1800000000000 }]
                : [];
          if (args.path === '/session' && args.method === 'POST')
            return { id: sessionId, title: '新会话', updatedAt: 1800000000000 };
          if (args.path.split('?')[0].endsWith('/events')) {
            const params = new URLSearchParams(args.path.split('?')[1]);
            const startIndex = Number(params.get('startIndex') ?? 0);
            const target = args.path.split('/')[2];
            const history = histories[target] ?? [];
            return {
              sessionId: target,
              startIndex,
              revision: history.length,
              generation: '00000000-0000-4000-8000-000000000001',
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
  await page.addInitScript(initialize, existing);
}

test('native event records project into the conversation without a Node HTTP bridge', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.getByRole('textbox', { name: '输入消息' }).fill('验证原生连接');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Corax 原生连接成功。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '仪器', exact: true })).toBeDisabled();
});

test('current settings edit one canonical configuration', async ({ page }) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('模型名称', { exact: false })).toHaveValue('local');
  await page.getByRole('button', { name: 'LLM Wiki', exact: true }).click();
  await expect(page.getByText('纯文本来源', { exact: true })).toBeVisible();
  await expect(page.getByText('SQLite 资料包', { exact: true })).toHaveCount(0);
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

test('switching conversations loads the selected Corax history without a cross-session cache', async ({
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
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).__desktopTest.requests.filter(
          (path: string) => path === '/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events',
        ).length,
    ),
  ).toBe(2);
});
