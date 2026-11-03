import { test, expect, type Page } from '@playwright/test';

async function mockDesktop(
  page: Page,
  options: {
    sessionCount?: number;
    failPageOnce?: boolean;
    overlapPage?: boolean;
    hasApiKey?: boolean;
    apiKeySource?: 'environment' | 'keyring';
  } = {},
) {
  await page.addInitScript(
    ({
      sessionCount = 0,
      failPageOnce = false,
      overlapPage = false,
      hasApiKey = false,
      apiKeySource = 'keyring',
    }) => {
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
      (window as any).__desktopTest = {
        saves: [],
        submissions: 0,
        windowActions: [],
        sessionRequests: [],
        refreshSessions: () => emit('session.updated', {}),
      };
      const sessionRows = Array.from({ length: sessionCount }, (_, index) => ({
        id: `12345678-1234-4234-8234-${String(index + 1).padStart(12, '0')}`,
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
            events[args.event] = args.handler;
            return ++next;
          }
          if (command === 'plugin:event|unlisten') return;
          if (command === 'backend_start') return { ready: true };
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
    },
    options,
  );
}

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
  await page.getByRole('button', { name: '设备连接', exact: true }).click();
  await expect(page.getByLabel('厂家 API 地址', { exact: false })).toHaveValue(
    'http://127.0.0.1:18080/api/v1',
  );
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
