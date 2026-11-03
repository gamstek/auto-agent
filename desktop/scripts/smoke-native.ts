import { chromium } from '@playwright/test';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const binary = resolve(process.argv[2] ?? 'src-tauri/target/debug/auto-agent-desktop.exe');
const scratch = join(tmpdir(), 'opencode');
await mkdir(scratch, { recursive: true });
const output = await mkdtemp(join(scratch, 'desktop-native-'));
const profile = join(output, 'profile');
await mkdir(profile);
const key = 'desktop-isolated-smoke-key';
let requests = 0,
  authMatches = true;
let releaseReply: (() => void) | undefined;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    requests++;
    if (request.headers.get('authorization') !== `Bearer ${key}`) authMatches = false;
    const input = (await request.json()) as { stream?: boolean };
    if (input.stream)
      await new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
    const base = { id: 'desktop-local', created: 1700000000, model: 'desktop-smoke' };
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (input.stream)
      return new Response(
        [
          {
            ...base,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: '桌面联调成功：本次仅连接本地模拟模型。' },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
          { ...base, object: 'chat.completion.chunk', choices: [], usage },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    return Response.json({
      ...base,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '本地桌面联调' },
          finish_reason: 'stop',
        },
      ],
      usage,
    });
  },
});
const debuggingPort = 19327;
const child = Bun.spawn([binary, '--data-dir', profile], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debuggingPort}`,
    AUTO_AGENT_API_KEY: '',
  },
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
});
const stdout = new Response(child.stdout).text(),
  stderr = new Response(child.stderr).text();
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let page: import('@playwright/test').Page | undefined;
const invoke = async <T>(name: string, args?: Record<string, unknown>) =>
  page!.evaluate(({ name, args }) => (window as any).__TAURI_INTERNALS__.invoke(name, args), {
    name,
    args,
  }) as Promise<T>;
try {
  for (let i = 0; i < 100; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`, {
        timeout: 1000,
      });
      break;
    } catch {
      await Bun.sleep(300);
    }
  }
  if (!browser) throw new Error('WebView2 debugging endpoint did not become available');
  for (let i = 0; i < 100; i++) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find(
        (candidate) =>
          !candidate.url().includes('launcher') && !candidate.url().startsWith('about:'),
      );
    if (page) break;
    await Bun.sleep(100);
  }
  if (!page) throw new Error('Main WebView not found');
  await page.locator('.app[data-backend-state="connected"]').waitFor({ timeout: 30000 });
  const initialWindow = await invoke<any>('window_action', { action: 'state' });
  if (initialWindow.decorated) throw new Error('Native titlebar is still enabled');
  await page.getByRole('button', { name: '最大化窗口' }).click();
  await page.getByRole('button', { name: '还原窗口' }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: '还原窗口' }).click();
  await page.getByRole('button', { name: '最大化窗口' }).waitFor({ timeout: 5000 });
  await page.locator('.titlebar-drag').dispatchEvent('dblclick');
  await page.getByRole('button', { name: '还原窗口' }).waitFor({ timeout: 5000 });
  await page.locator('.titlebar-drag').dispatchEvent('dblclick');
  await page.getByRole('button', { name: '最大化窗口' }).waitFor({ timeout: 5000 });
  await page.screenshot({ path: join(output, 'native-welcome.png') });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('服务地址', { exact: false }).fill(`${server.url.origin}/v1`);
  await page.getByLabel('模型名称', { exact: false }).fill('desktop-smoke');
  await page.getByPlaceholder('输入你的 API Key').fill(key);
  await page.getByText('已配置。留空保留现有 Key。', { exact: true }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(output, 'native-settings.png') });
  const settings = await readFile(join(profile, 'config.json'), 'utf8');
  if (settings.includes(key)) throw new Error('API key appeared in plaintext settings');
  await page.getByRole('button', { name: '返回聊天', exact: true }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('本地桌面联调，请直接回答。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  for (let i = 0; i < 100 && !releaseReply; i++) await Bun.sleep(50);
  if (!releaseReply) throw new Error('Mock generation did not start');
  let busyExitBlocked = false;
  try {
    await invoke('exit_app');
  } catch {
    busyExitBlocked = true;
  }
  if (!busyExitBlocked || child.exitCode !== null)
    throw new Error('Active work did not prevent application exit');
  const whileRunning = await invoke<any>('settings_read');
  const nextSteps = whileRunning.settings.maxSteps + 1;
  const deferred = await invoke<any>('settings_save', {
    settings: { ...whileRunning.settings, maxSteps: nextSteps },
    configRevision: whileRunning.configRevision,
    apiKey: null,
    clearKey: false,
  });
  if (deferred.applied !== false || !deferred.saved)
    throw new Error('Settings were not deferred while work was active');
  const runtime = await invoke<any>('backend_request', {
    method: 'GET',
    path: '/runtime',
    body: null,
  });
  if (runtime.runningSessions.length !== 1)
    throw new Error('Saving settings interrupted active generation');
  if (JSON.parse(await readFile(join(profile, 'config.json'), 'utf8')).maxSteps !== nextSteps)
    throw new Error('Deferred settings were not persisted');
  releaseReply();
  await page
    .getByText('桌面联调成功：本次仅连接本地模拟模型。', { exact: true })
    .waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '复制回复', exact: true }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: join(output, 'native-conversation.png') });
  if (!requests || !authMatches) throw new Error('Model request/authentication mismatch');
  const sessions = await invoke<any[]>('backend_request', {
    method: 'GET',
    path: '/session',
    body: null,
  });
  const state = await invoke<any>('backend_request', {
    method: 'GET',
    path: `/session/${sessions[0].id}/state`,
    body: null,
  });
  if (state.running || state.run?.status !== 'completed')
    throw new Error('Desktop task did not finish');
  let applied = false;
  for (let i = 0; i < 150; i++) {
    if (JSON.parse(await readFile(join(profile, 'backend.json'), 'utf8')).maxSteps === nextSteps) {
      applied = true;
      break;
    }
    await Bun.sleep(100);
  }
  if (!applied) throw new Error('Deferred settings were not applied after the task finished');
  await page.locator('.app[data-backend-state="connected"]').waitFor({ timeout: 30000 });
  await invoke('window_action', { action: 'minimize' });
  await invoke('show_main');
  await page.getByRole('button', { name: '收起至悬浮助手', exact: true }).click();
  await Bun.sleep(200);
  if ((await invoke<any>('window_action', { action: 'state' })).visible)
    throw new Error('Dedicated launcher control did not hide the main window');
  await invoke('show_main');
  await page.reload();
  await page.locator('.app[data-backend-state="connected"]').waitFor({ timeout: 30000 });
  await page
    .getByText('桌面联调成功：本次仅连接本地模拟模型。', { exact: true })
    .waitFor({ timeout: 10000 });
  const info = await invoke<any>('settings_read');
  await invoke('settings_save', {
    settings: info.settings,
    configRevision: info.configRevision,
    apiKey: null,
    clearKey: true,
  });
  const noKey = await invoke<any>('settings_read');
  if (noKey.hasApiKey) throw new Error('Test key removal failed');
  await page
    .getByRole('button', { name: '关闭窗口', exact: true })
    .click()
    .catch(() => {});
  const exit = await Promise.race([child.exited, Bun.sleep(15000).then(() => -999)]);
  if (exit !== 0) throw new Error(`Desktop exit failed (${exit})`);
  const logs = await readFile(join(profile, 'logs/agent.jsonl'), 'utf8');
  if (logs.includes(key)) throw new Error('Test key appeared in logs');
  const result = {
    passed: true,
    binary,
    output,
    modelRequests: requests,
    backend: 'local mock only',
    savedKeyOutsideConfig: true,
    keyRemoved: true,
    reloadRestoredSession: true,
    gracefulExit: true,
    customTitlebar: true,
    nativeDecorationsDisabled: true,
    windowControlsVerified: true,
    closeButtonExitsApplication: true,
    busyExitBlocked,
    automaticSettingsSave: true,
    activeTaskPreservedDuringSettingsSave: true,
    deferredSettingsApplied: true,
  };
  await writeFile(join(output, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    console.error(
      await page
        .locator('body')
        .innerText()
        .catch(() => 'No readable UI'),
    );
  }
  console.error(`Native smoke artifacts: ${output}`);
  throw error;
} finally {
  releaseReply?.();
  if (child.exitCode === null && page) {
    try {
      const info = await invoke<any>('settings_read');
      await invoke('settings_save', {
        settings: info.settings,
        configRevision: info.configRevision,
        apiKey: null,
        clearKey: true,
      });
      await invoke('exit_app');
    } catch {}
  }
  await browser?.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  await child.exited;
  await stdout;
  await stderr;
  server.stop(true);
}
