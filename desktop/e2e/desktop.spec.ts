import { test, expect, type Page } from '@playwright/test';

async function mockDesktop(page: Page) {
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    const callbacks: Record<number, (value: unknown) => void> = {};
    const events: Record<string, number> = {};
    const id = '12345678-1234-4234-8234-123456789abc';
    let next = 0,
      running = false;
    const messages: any[] = [];
    const settings = {
      model: 'deepseek-flash',
      baseURL: 'https://api.deepseek.com',
      manufacturerUrl: 'http://127.0.0.1:18080/api/v1',
      manufacturerTimeoutMs: 5000,
      templateDirectory: '',
      builtinSkills: true,
      builtinWiki: true,
      skillRoots: [],
      wikiRoots: [],
      wikiIndexRoots: [],
      maxSteps: 24,
      maxInputTokens: 1000000,
      maxOutputTokens: 16000,
      modelTimeoutMs: 60000,
      scriptTimeoutMs: 30000,
      webAllowPrivateAddresses: true,
      systemPrompt: '',
    };
    const emit = (type: string, properties: unknown) =>
      callbacks[events['agent-event']]?.({
        event: 'agent-event',
        id: 1,
        payload: { type, sessionId: id, messageId: 'answer-1', properties },
      });
    (window as any).__desktopTest = { saves: [], submissions: 0, windowActions: [] };
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
        if (command === 'window_action') {
          (window as any).__desktopTest.windowActions.push(args.action);
          if (args.action === 'toggle-maximize') maximized = !maximized;
          return { maximized };
        }
        if (command === 'plugin:event|listen') {
          events[args.event] = args.handler;
          return ++next;
        }
        if (command === 'plugin:event|unlisten') return;
        if (command === 'backend_start') return { ready: true };
        if (command === 'settings_read')
          return {
            settings,
            hasApiKey: false,
            version: '2.0.0-beta.1',
            dataDirectory: 'C:\\DesktopTest\\data',
          };
        if (command === 'settings_save') {
          (window as any).__desktopTest.saves.push(args);
          Object.assign(settings, args.settings);
          return { saved: true };
        }
        if (command === 'backend_request') {
          if (args.path === '/session' && args.method === 'POST')
            return { id, title: 'New session', updatedAt: Date.now() };
          if (args.path.startsWith('/session?'))
            return messages.length ? [{ id, title: 'BET 方法咨询', updatedAt: Date.now() }] : [];
          if (args.path.endsWith('/state'))
            return {
              running,
              run: { id: 'run-test', status: running ? 'running' : 'completed' },
              pending: null,
              logs: {},
            };
          if (args.path.includes('/message?')) return messages;
          if (args.path.endsWith('/prompt_async')) {
            (window as any).__desktopTest.submissions++;
            messages.push({
              id: 'user-1',
              sessionId: id,
              role: 'user',
              content: args.body.content,
              createdAt: Date.now(),
            });
            running = true;
            setTimeout(() => {
              emit('message.part.delta', { delta: 'BET 用于比表面积分析。' });
            }, 100);
            setTimeout(() => {
              messages.push({
                id: 'answer-1',
                sessionId: id,
                role: 'assistant',
                content:
                  'BET 用于**比表面积**分析。\n\n| 参数 | 值 |\n| --- | --- |\n| 气体 | N₂ |',
                createdAt: Date.now(),
              });
              running = false;
              emit('message.completed', {});
              emit('session.status', { status: 'idle' });
            }, 400);
            return null;
          }
          if (args.path.endsWith('/abort')) {
            running = false;
            return { aborted: true };
          }
          throw new Error(`Unexpected mock path ${args.path}`);
        }
        return null;
      },
    };
  });
}
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
  for (const section of ['模型连接', '设备连接', '技能与知识库', '运行参数', '关于与诊断']) {
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
  const scroller = page.locator('.settings-scroll');
  expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  expect(
    await scroller.evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar').width),
  ).toBe('8px');
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
  expect(data.storage).not.toContain('local-ui-test-key');
  await page.getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(page.getByLabel('厂家 API 地址', { exact: false })).toHaveValue(
    'http://127.0.0.1:18080/api/v1',
  );
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
