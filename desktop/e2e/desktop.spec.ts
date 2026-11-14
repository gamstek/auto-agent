import { test, expect, type Page } from '@playwright/test';

async function nativeDesktop(
  page: Page,
  existing = false,
  suggestionMode: 'ready' | 'hold' | 'fail' = 'ready',
  deviceMode: 'unsupported' | 'empty' | 'configured' = 'unsupported',
) {
  const initialize = ({
    existing,
    suggestionMode,
    deviceMode,
  }: {
    existing: boolean;
    suggestionMode: string;
    deviceMode: string;
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
      renames: [] as { id: string; title: string }[],
      sessionTitles: {} as Record<string, string>,
      failRename: false,
      backendStarts: 0,
      rejectSend: false,
      approvalChanges: [] as any[],
      approvalPolicy: { mode: 'always', revision: 0 },
      responses: [] as any[],
      responseFailure: '' as '' | 'rejected' | 'unknown',
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
      failPreview: false,
      // Older protocol-v4 backends cannot certify a tail as a complete prefix.
      confirmCompleteTail: false,
      holdPreviewFor: '',
      holdList: false,
      knowledgeStarts: [] as any[],
      knowledgePageRequests: [] as string[],
      knowledgeReads: [] as any[],
      holdKnowledgeReadFor: '',
      knowledgeUncertain: false,
      knowledgeReject: false,
      knowledgeConfigRevision: 'revision',
      pendingSettingsApply: false,
      suggestionRequests: 0,
      updateInstallCalls: 0,
      suggestionFailure: suggestionMode === 'fail',
      holdSuggestions: suggestionMode === 'hold',
      deviceCapability: deviceMode !== 'unsupported',
      failDeviceRefresh: false,
      holdDeviceRefresh: false,
      devices:
        deviceMode === 'configured'
          ? [
              {
                deviceId: 'climber',
                name: 'Climber',
                source: 'climber-mcp',
                transport: 'connected',
                vendorReachability: 'reachable',
                health: { softwareReady: true, deviceConnected: true, deviceBusy: true },
                task: {
                  batchId: 'batch-fixture',
                  state: 'running',
                  experiments: [
                    { experimentId: 'experiment-fixture', analysisPort: 3, state: 'running' },
                  ],
                },
                taskKnown: true,
                observedAt: 1800000000000,
                revision: 1,
                stale: false,
                error: null,
              },
            ]
          : [],
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
    const releaseKnowledgeReads: (() => void)[] = [];
    const releaseDeviceReads: (() => void)[] = [];
    const releasePreviewReads: (() => void)[] = [];
    let knowledgeOperation: any = null;
    let knowledgeDone = 0;
    (window as any).__desktopTest = testState;
    let next = 0,
      watchId = '',
      submitted = false;
    const settings = {
      approvalMode: 'always',
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
      requestInput: (kind: 'tool-approval' | 'question' = 'tool-approval') => {
        const startIndex = records.length;
        const coordinates = { turnId: 'interactive-turn', sequence: 1, stepIndex: 0 };
        const toolName = kind === 'tool-approval' ? 'bash' : 'ask_question';
        const input =
          kind === 'tool-approval'
            ? { command: 'printf approval-fixture' }
            : {
                question: '请选择输出格式',
                options: [
                  { label: 'Markdown', description: '保留格式与链接' },
                  { label: 'TXT', description: '使用纯文本内容' },
                ],
              };
        const add = (type: string, data: unknown) =>
          records.push({
            type,
            data,
            meta: { id: `interactive-${records.length}`, at: '2026-11-12T08:00:00Z' },
          });
        add('turn.started', coordinates);
        add('message.received', { ...coordinates, message: '请按已确认内容继续处理' });
        add('message.completed', {
          ...coordinates,
          message: '我已准备好下一步，等待你的确认。',
          finishReason: 'tool-calls',
        });
        add('actions.requested', {
          ...coordinates,
          actions: [{ callId: 'interactive-call', kind: 'tool-call', toolName, input }],
        });
        add('input.requested', {
          ...coordinates,
          requests: [
            {
              requestId: 'interactive-request',
              kind,
              prompt:
                kind === 'tool-approval'
                  ? '即将运行一条宿主命令，请确认本次调用。'
                  : '请选择输出格式',
              action: { callId: 'interactive-call', kind: 'tool-call', toolName, input },
              allowFreeform: kind === 'question',
              options:
                kind === 'tool-approval'
                  ? [
                      { id: 'approve', label: 'Approve', style: 'primary' },
                      { id: 'cancel', label: 'Cancel' },
                    ]
                  : [
                      { id: 'Markdown', label: 'Markdown', description: '保留格式与链接' },
                      { id: 'TXT', label: 'TXT', description: '使用纯文本内容' },
                    ],
            },
          ],
        });
        emit('corax-events', {
          sessionId,
          generation: testState.generation,
          watchId,
          startIndex,
          events: structuredClone(records.slice(startIndex)),
        });
      },
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
      publishKnowledge: () => {
        knowledgeDone = 1;
      },
      releaseKnowledgeReads: () => {
        testState.holdKnowledgeReadFor = '';
        for (const release of releaseKnowledgeReads.splice(0)) release();
      },
      releaseDeviceReads: () => {
        testState.holdDeviceRefresh = false;
        for (const release of releaseDeviceReads.splice(0)) release();
      },
      releasePreviewReads: () => {
        testState.holdPreviewFor = '';
        for (const release of releasePreviewReads.splice(0)) release();
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
        if (command === 'backend_start') {
          testState.backendStarts++;
          testState.approvalPolicy = { mode: settings.approvalMode, revision: 0 };
          return { ready: true };
        }
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
          if (args.path === '/approval') {
            if (args.method === 'GET')
              return { generation: testState.generation, ...testState.approvalPolicy };
            testState.approvalChanges.push(args.body);
            if (args.body.generation !== testState.generation)
              throw new Error('审批策略的后端身份已经变化');
            const previous = testState.approvalPolicy;
            if (previous.revision !== args.body.revision) throw new Error('审批策略已经变化');
            const value = { mode: args.body.mode, revision: previous.revision + 1 };
            testState.approvalPolicy = value;
            settings.approvalMode = value.mode;
            return { generation: testState.generation, ...value };
          }
          if (args.path.endsWith('/respond')) {
            testState.responses.push(args.body.responses);
            if (testState.responseFailure)
              throw { message: '隔离审批响应失败', admission: testState.responseFailure };
            const startIndex = records.length;
            const request = [...records]
              .reverse()
              .find((event) => event.type === 'input.requested')!.data.requests[0];
            const response = args.body.responses[0];
            const approved = response.optionId === 'approve';
            const coordinates = { turnId: 'interactive-turn', sequence: 1, stepIndex: 0 };
            const add = (type: string, data: unknown) =>
              records.push({
                type,
                data,
                meta: { id: `interactive-${records.length}`, at: '2026-11-12T08:00:01Z' },
              });
            add('input.resolved', {
              ...coordinates,
              resolutions: [
                {
                  kind: request.kind,
                  requestId: request.requestId,
                  outcome:
                    request.kind === 'question' ? 'answered' : approved ? 'approved' : 'denied',
                  response,
                },
              ],
            });
            add('action.result', {
              ...coordinates,
              status: request.kind === 'question' || approved ? 'completed' : 'rejected',
              result: {
                kind: 'tool-result',
                callId: 'interactive-call',
                toolName: request.action.toolName,
                output:
                  request.kind === 'question'
                    ? { answer: response.text ?? response.optionId, status: 'answered' }
                    : approved
                      ? 'approval-fixture'
                      : 'Tool execution was denied.',
              },
            });
            add('message.completed', {
              ...coordinates,
              stepIndex: 1,
              message: '已按你的选择继续。',
              finishReason: 'stop',
            });
            add('turn.completed', coordinates);
            emit('corax-events', {
              sessionId,
              generation: testState.generation,
              watchId,
              startIndex,
              events: structuredClone(records.slice(startIndex)),
            });
            return { ok: true };
          }
          if (args.path === '/devices') return structuredClone(testState.devices);
          if (args.path === '/devices/climber/refresh') {
            const snapshot = structuredClone(testState.devices[0]);
            if (testState.holdDeviceRefresh)
              await new Promise<void>((resolve) => releaseDeviceReads.push(resolve));
            if (testState.failDeviceRefresh) throw new Error('模拟厂家接口暂不可访问');
            return snapshot;
          }
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
            related: ['concepts/extra.md'],
            sourceCount: 1,
            updatedAt: '2026-11-09T08:00:00.000Z',
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
                  related: ['concepts/notes.md'],
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
          if (args.path === '/knowledge/read') {
            testState.knowledgeReads.push(structuredClone(args.body.reference));
            if (testState.holdKnowledgeReadFor === args.body.reference.path)
              await new Promise<void>((resolve) => releaseKnowledgeReads.push(resolve));
            return {
              reference: args.body.reference,
              title:
                args.body.reference.path === 'concepts/extra.md'
                  ? '额外知识页'
                  : knowledgePage.title,
              text: args.body.offset
                ? '后续内容也保留来源。'
                : '# 整理后的笔记\n这是有来源的知识正文。',
              startLine: args.body.offset ? 61 : 1,
              endLine: args.body.offset ? 62 : 60,
              nextOffset: args.body.offset ? null : 60,
            };
          }
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
                devices: { list: testState.deviceCapability },
              },
            };
          if (args.path.startsWith('/session?')) {
            const rows = existing
              ? [
                  {
                    id: sessionId,
                    title: testState.sessionTitles[sessionId] ?? '会话一',
                    updatedAt: 1800000000001,
                  },
                  {
                    id: secondId,
                    title: testState.sessionTitles[secondId] ?? '会话二',
                    updatedAt: 1800000000000,
                  },
                ]
              : submitted
                ? [{ id: sessionId, title: '原生会话', updatedAt: 1800000000000 }]
                : [];
            if (testState.holdList) await new Promise<void>((resolve) => releaseList.push(resolve));
            return rows;
          }
          if (args.path.endsWith('/title') && args.method === 'PATCH') {
            const id = args.path.split('/')[2];
            testState.renames.push({ id, title: args.body.title });
            if (testState.failRename) throw new Error('保存失败，请刷新会话列表核对结果。');
            testState.sessionTitles[id] = args.body.title.trim();
            return { id, title: testState.sessionTitles[id] };
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
            if (params.has('tail')) {
              if (testState.failPreview) throw new Error('测试尾部预览不可读');
              const count = Number(params.get('tail'));
              const generation = testState.generation;
              const history = structuredClone(histories[target] ?? []);
              const startIndex = Math.max(0, history.length - count);
              if (testState.holdPreviewFor === target)
                await new Promise<void>((resolve) => releasePreviewReads.push(resolve));
              return {
                sessionId: target,
                generation,
                startIndex,
                revision: history.length,
                admitted: false,
                preview: !(testState.confirmCompleteTail && startIndex === 0),
                complete: testState.confirmCompleteTail && startIndex === 0,
                events: history.slice(startIndex),
              };
            }
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
  await page.addInitScript(initialize, { existing, suggestionMode, deviceMode });
}

async function openKnowledgeSources(page: Page) {
  const back = page.getByRole('button', { name: '返回知识浏览', exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole('tab', { name: '资料', exact: true }).click();
  const sources = page.getByRole('tabpanel', { name: '资料', exact: true });
  await expect(sources).toBeVisible();
  return sources;
}

async function openKnowledgeDirectory(page: Page) {
  const back = page.getByRole('button', { name: '返回知识浏览', exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole('tab', { name: '目录', exact: true }).click();
  const directory = page.getByRole('tabpanel', { name: '目录', exact: true });
  await expect(directory).toBeVisible();
  return directory;
}

test('pending approvals sit above the full-width composer without duplicate history cards', async ({
  page,
}, testInfo) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  const original = await page.locator('.conversation-inner').boundingBox();
  await page.evaluate(() => (window as any).__desktopFixture.requestInput());
  // Sections without an accessible heading still carry their explicit label.
  const pending = page.locator('.chat-input-dock .chat-input-request');
  await expect(pending.getByRole('button', { name: '批准本次', exact: true })).toBeVisible();
  expect((await pending.boundingBox())!.height).toBeLessThan(190);
  expect((await page.locator('.conversation-inner').boundingBox())!.width).toBe(original!.width);
  const lastMessage = page.locator('.corax-message').last();
  const bounds = await lastMessage.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual((await pending.boundingBox())!.y + 2);
  const composer = await page.locator('.composer').boundingBox();
  expect(composer!.height).toBeGreaterThanOrEqual(96);
  expect(composer!.height).toBeLessThanOrEqual(130);
  await page.screenshot({ path: testInfo.outputPath('approval-pending.png') });
  await pending.getByRole('button', { name: '批准本次', exact: true }).click();
  await expect(page.locator('.chat-input-dock')).toHaveCount(0);
  await expect(page.locator('.conversation .chat-input-request, .chat-input-record')).toHaveCount(
    0,
  );
  await expect(page.locator('.chat-tool[data-call-id="interactive-call"]')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__desktopTest.responses)).toEqual([
    [{ requestId: 'interactive-request', optionId: 'approve' }],
  ]);
  await page.screenshot({ path: testInfo.outputPath('approval-record.png') });
});

test('composer policy is global, switches without history reads and never submits approval responses', async ({
  page,
}, testInfo) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: /^会话一/ }).click();
  const trigger = page.getByRole('button', { name: '审批策略', exact: true });
  await expect(trigger).toContainText('每次批准');
  const historyReads = await page.evaluate(
    () =>
      (window as any).__desktopTest.requests.filter((path: string) =>
        path.split('?')[0].endsWith('/events'),
      ).length,
  );
  await trigger.click();
  await expect(page.getByRole('menu', { name: '选择审批策略' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('approval-policy-popup.png') });
  await page.getByRole('menuitemradio', { name: /无需批准/ }).click();
  await expect(trigger).toContainText('无需批准');
  expect(
    await page.evaluate(
      () =>
        (window as any).__desktopTest.requests.filter((path: string) =>
          path.split('?')[0].endsWith('/events'),
        ).length,
    ),
  ).toBe(historyReads);
  const policyReads = await page.evaluate(
    () =>
      (window as any).__desktopTest.requests.filter((path: string) => path === '/approval').length,
  );
  expect(await page.evaluate(() => (window as any).__desktopTest.approvalChanges.at(-1).mode)).toBe(
    'never',
  );
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(trigger).toContainText('无需批准');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(trigger).toContainText('无需批准');
  expect(
    await page.evaluate(
      () =>
        (window as any).__desktopTest.requests.filter((path: string) => path === '/approval')
          .length,
    ),
  ).toBe(policyReads);
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitemradio', { name: /每次批准/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(trigger).toContainText('每会话首次批准');
  await page.evaluate(() => (window as any).__desktopFixture.requestInput());
  await expect(page.locator('.chat-input-dock')).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('menuitemradio', { name: /无需批准/ })).toHaveAttribute(
    'aria-disabled',
    'false',
  );
  await page.getByRole('menuitemradio', { name: /无需批准/ }).dispatchEvent('click');
  await expect(trigger).toContainText('无需批准');
  expect(await page.evaluate(() => (window as any).__desktopTest.approvalChanges.length)).toBe(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-input-dock .chat-input-request')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.responses)).toEqual([]);
});

test('composer approval selection restores from settings after a backend restart without replaying a policy update', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: /^会话一/ }).click();
  const trigger = page.getByRole('button', { name: '审批策略', exact: true });
  await trigger.click();
  await page.getByRole('menuitemradio', { name: /无需批准/ }).click();
  await expect(trigger).toContainText('无需批准');
  await page.evaluate(() =>
    (window as any).__desktopFixture.emit('backend-stream', 'disconnected'),
  );
  await page.getByRole('button', { name: '重新连接', exact: true }).click();
  await expect(trigger).toContainText('无需批准');
  await expect(trigger).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__desktopTest.backendStarts)).toBe(2);
  expect(await page.evaluate(() => (window as any).__desktopTest.approvalChanges.length)).toBe(1);
});

test('native ask_question uses compact single-choice rows and the composer submit button without hiding messages', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await page.evaluate(() => (window as any).__desktopFixture.requestInput('question'));
  const dock = page.locator('.chat-input-dock');
  await expect(dock.getByRole('radio', { name: /Markdown/ })).toBeVisible();
  const submit = page.getByRole('button', { name: '提交回答', exact: true });
  await expect(submit).toBeDisabled();
  await dock.getByRole('radio', { name: /TXT/ }).check();
  await expect(submit).toBeEnabled();
  expect(
    await dock
      .locator('.chat-input-content')
      .evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);
  const composer = await page.locator('.composer').boundingBox();
  const card = await dock.boundingBox();
  expect(Math.abs(composer!.width - card!.width)).toBeLessThan(2);
  expect(Math.abs(composer!.x - card!.x)).toBeLessThan(2);
  const message = await page.locator('.corax-message').last().boundingBox();
  expect(message!.y + message!.height).toBeLessThanOrEqual(card!.y + 2);
  await page.screenshot({ path: testInfo.outputPath('question-composer.png') });
  await submit.click();
  await expect(dock).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__desktopTest.responses)).toEqual([
    [{ requestId: 'interactive-request', optionId: 'TXT' }],
  ]);
  await expect(page.locator('.conversation .chat-input-request, .chat-input-record')).toHaveCount(
    0,
  );
  await expect(page.locator('.chat-tool[data-call-id="interactive-call"]')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('question-history-record.png') });
});

test('an ambiguous approval response locks the card and never automatically resubmits', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await page.evaluate(() => {
    (window as any).__desktopTest.responseFailure = 'unknown';
    (window as any).__desktopFixture.requestInput();
  });
  const button = page
    .locator('.chat-input-dock')
    .getByRole('button', { name: '批准本次', exact: true });
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.locator('.chat-input-dock')).toContainText('不会自动重复提交');
  expect(await page.evaluate(() => (window as any).__desktopTest.responses.length)).toBe(1);
});

test('a new conversation applies its selected policy before message admission', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '审批策略', exact: true });
  await trigger.click();
  await page.getByRole('menuitemradio', { name: /无需批准/ }).click();
  await expect(trigger).toContainText('无需批准');
  await page
    .getByRole('textbox', { name: '输入消息', exact: true })
    .fill('用选中的策略开始本次会话');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByText('Corax 原生连接成功。', { exact: true })).toBeVisible();
  const state = await page.evaluate(() => (window as any).__desktopTest);
  expect(state.approvalChanges[0].mode).toBe('never');
  expect(state.requests.indexOf('/approval')).toBeLessThan(
    state.requests.findIndex((path: string) => path.endsWith('/prompt_async')),
  );
});

test('native custom answers use the same submit action and survive an explicit rejection', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await page.evaluate(() => {
    (window as any).__desktopTest.responseFailure = 'rejected';
    (window as any).__desktopFixture.requestInput('question');
  });
  const dock = page.locator('.chat-input-dock');
  const answer = dock.getByRole('textbox', { name: '回答内容' });
  await answer.fill('保留完整自定义回答');
  await answer.press('Control+Enter');
  await expect(dock).toContainText('隔离审批响应失败');
  await expect(answer).toHaveValue('保留完整自定义回答');
  await expect(page.getByRole('button', { name: '提交回答', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__desktopTest.responseFailure = '';
  });
  await page.getByRole('button', { name: '提交回答', exact: true }).click();
  await expect(dock).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__desktopTest.responses.at(-1))).toEqual([
    { requestId: 'interactive-request', text: '保留完整自定义回答' },
  ]);
});

test('instrument monitor opens selected on wide screens without moving chat content and floats over narrow chats', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nativeDesktop(page, true, 'ready', 'configured');
  await page.goto('/');
  await page.evaluate(() => {
    const history = (window as any).__desktopFixture.histories['wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB'];
    history.find((event: any) => event.type === 'message.completed').data.message =
      '会话一的回复\n\n' +
      Array.from(
        { length: 40 },
        (_, index) => `第 ${index + 1} 条测量记录：这是用于检查长对话滚动布局的隔离内容。`,
      ).join('\n\n');
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  const panel = page.getByRole('complementary', { name: '仪器实时状态' });
  const toggle = page.getByRole('button', { name: '仪器状态', exact: true });
  const refresh = panel.getByRole('button', { name: '刷新仪器状态', exact: true });
  await expect(panel).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(refresh).toBeEnabled();
  await expect(panel.getByText('批次：batch-fixture', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      panel.evaluate(
        (element) =>
          element.getAnimations().filter((animation) => animation.playState === 'running').length,
      ),
    )
    .toBe(0);
  const content = await page.locator('.conversation-inner').boundingBox();
  const composerBefore = await page.locator('.composer-region').boundingBox();
  const scrollBefore = await page.locator('.conversation').evaluate((element) => element.scrollTop);
  const docked = await panel.boundingBox();
  const conversation = await page.locator('.conversation').boundingBox();
  expect(conversation!.x + conversation!.width).toBeGreaterThan(docked!.x + docked!.width + 8);
  expect(
    await page
      .locator('.conversation')
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  ).toBe(true);
  expect(await page.locator('.main-area').evaluate((element) => element.scrollTop)).toBe(0);
  expect(await page.locator('.view-host').evaluate((element) => element.scrollTop)).toBe(0);
  await toggle.click();
  await expect(page.locator('.instrument-monitor')).toHaveCount(0);
  expect(await page.locator('.conversation-inner').boundingBox()).toEqual(content);
  expect(await page.locator('.composer-region').boundingBox()).toEqual(composerBefore);
  expect(await page.locator('.conversation').evaluate((element) => element.scrollTop)).toBe(
    scrollBefore,
  );
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect
    .poll(() =>
      panel.evaluate(
        (element) =>
          element.getAnimations().filter((animation) => animation.playState === 'running').length,
      ),
    )
    .toBe(0);
  expect(await page.locator('.conversation-inner').boundingBox()).toEqual(content);
  expect(await page.locator('.composer-region').boundingBox()).toEqual(composerBefore);
  const toolbar = await page.locator('.content-toolbar').boundingBox();
  expect(docked!.y).toBeGreaterThanOrEqual(toolbar!.y + toolbar!.height + 8);
  expect(await panel.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  expect(
    await page.locator('.content-toolbar').evaluate((element) =>
      [...element.querySelectorAll('button')].every((button) => {
        const bounds = button.getBoundingClientRect();
        return (
          document
            .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
            ?.closest('button') === button
        );
      }),
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('instrument-monitor-wide.png') });
  await page.setViewportSize({ width: 1280, height: 860 });
  await toggle.click();
  await expect(page.locator('.instrument-monitor')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  const before = await page.locator('.chat-thread').boundingBox();
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect
    .poll(() =>
      panel.evaluate(
        (element) =>
          element.getAnimations().filter((animation) => animation.playState === 'running').length,
      ),
    )
    .toBe(0);
  const after = await page.locator('.chat-thread').boundingBox();
  expect(after!.width).toBe(before!.width);
  const floating = await panel.boundingBox();
  const composer = await page.locator('.composer-region').boundingBox();
  const narrowToolbar = await page.locator('.content-toolbar').boundingBox();
  expect(floating!.y).toBeGreaterThanOrEqual(narrowToolbar!.y + narrowToolbar!.height + 8);
  expect(await page.locator('.main-area').evaluate((element) => element.scrollTop)).toBe(0);
  expect(floating!.y + floating!.height).toBeLessThan(composer!.y);
  await page.getByRole('textbox', { name: '输入消息' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('边查看仪器状态边继续对话');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('');
  await expect(panel).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('instrument-monitor-narrow.png') });
  await refresh.focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '开启新对话', exact: true }).click();
  await toggle.click();
  await expect(panel).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息' }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('在欢迎页也能边看边输入');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue(
    '在欢迎页也能边看边输入',
  );
});

test('instrument monitor slides in and retracts to the right with interruptible pointer motion and immediate accessible navigation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nativeDesktop(page, false, 'ready', 'configured');
  await page.addInitScript(() => {
    (window as any).__monitorMotion = [];
    document.addEventListener('transitionrun', (event) => {
      if (
        !(event.target as Element).matches('.instrument-monitor') ||
        event.propertyName !== 'transform'
      )
        return;
      const matrix = new DOMMatrix(getComputedStyle(event.target as Element).transform);
      const panel = event.target as HTMLElement;
      (window as any).__monitorMotion.push({
        x: matrix.m41,
        y: matrix.m42,
        closing: panel.dataset.open === 'false',
        inert: panel.inert,
      });
    });
  });
  await page.goto('/');
  const panel = page.getByRole('complementary', { name: '仪器实时状态' });
  const toggle = page.getByRole('button', { name: '仪器状态', exact: true });
  const motion = () => page.evaluate(() => (window as any).__monitorMotion);
  const nextFrames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(motion)
    .toEqual(expect.arrayContaining([expect.objectContaining({ x: expect.any(Number), y: 0 })]));
  expect((await motion())[0].x).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1280, height: 860 });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => {
    (window as any).__monitorMotion = [];
  });
  await toggle.click();
  await expect.poll(motion).toHaveLength(1);
  expect((await motion())[0].x).toBeGreaterThan(0);
  expect((await motion())[0].y).toBe(0);
  await panel.getByRole('button', { name: '收起仪器状态', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__monitorMotion.some(
          (entry: any) => entry.closing && entry.inert && entry.y === 0,
        ),
      ),
    )
    .toBe(true);
  await expect(page.locator('.instrument-monitor')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__monitorMotion = [];
  });
  await toggle.press('Enter');
  await expect(panel).toBeVisible();
  await nextFrames();
  expect(await motion()).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect
    .poll(() =>
      panel.evaluate(
        (element) =>
          element.getAnimations().filter((animation) => animation.playState === 'running').length,
      ),
    )
    .toBe(0);
  await panel.evaluate((element) => {
    (element as HTMLElement).dataset.presenceFixture = 'retained';
  });
  await panel.getByRole('button', { name: '收起仪器状态', exact: true }).click();
  await toggle.click();
  await expect(panel).toHaveAttribute('data-presence-fixture', 'retained');
  await page.waitForTimeout(300);
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.instrument-monitor')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__monitorMotion = [];
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await toggle.click();
  await expect(panel).toBeVisible();
  await nextFrames();
  expect(await motion()).toEqual([]);
});

test('instrument monitor reads only while visible and retains stale facts on read failure', async ({
  page,
}) => {
  await page.clock.install();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nativeDesktop(page, false, 'ready', 'configured');
  await page.goto('/');
  const panel = page.getByRole('complementary', { name: '仪器实时状态' });
  const refresh = panel.getByRole('button', { name: '刷新仪器状态', exact: true });
  await expect(refresh).toBeEnabled();
  const reads = () =>
    page.evaluate(
      () =>
        (window as any).__desktopTest.requests.filter((path: string) => path.startsWith('/devices'))
          .length,
    );
  const initial = await reads();
  await page.clock.runFor(3100);
  await expect.poll(reads).toBeGreaterThan(initial);
  await expect(refresh).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__desktopTest.failDeviceRefresh = true;
  });
  await refresh.click();
  await expect(panel.getByText('最后已知状态', { exact: true })).toBeVisible();
  await expect(panel.getByText('最后已知任务', { exact: true })).toBeVisible();
  await expect(panel.getByText('模拟厂家接口暂不可访问', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '收起仪器状态', exact: true }).click();
  const closed = await reads();
  await page.clock.runFor(15000);
  expect(await reads()).toBe(closed);
  await page.getByRole('button', { name: '仪器状态', exact: true }).click();
  await expect(refresh).toBeEnabled();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const left = await reads();
  await page.clock.runFor(15000);
  expect(await reads()).toBe(left);
  expect(
    await page.evaluate(() =>
      (window as any).__desktopTest.requests.filter(
        (path: string) =>
          path.startsWith('/devices') && path !== '/devices' && path !== '/devices/climber/refresh',
      ),
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(() =>
      (window as any).__desktopTest.requests.filter((path: string) =>
        path.endsWith('/prompt_async'),
      ),
    ),
  ).toEqual([]);
});

test('instrument monitor discards late reads at a backend identity change and represents unknown device facts explicitly', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nativeDesktop(page, false, 'ready', 'configured');
  await page.goto('/');
  const panel = page.getByRole('complementary', { name: '仪器实时状态' });
  const refresh = panel.getByRole('button', { name: '刷新仪器状态', exact: true });
  await expect(refresh).toBeEnabled();
  await page.evaluate(() => {
    const device = (window as any).__desktopTest.devices[0];
    device.health = { softwareReady: null, deviceConnected: null, deviceBusy: null };
    device.task = null;
    device.taskKnown = false;
  });
  await refresh.click();
  await expect(panel.getByText('未能确认', { exact: true })).toHaveCount(3);
  await expect(panel.getByText('尚未取得任务状态', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopTest.holdDeviceRefresh = true;
  });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.devices = [];
    state.generation = '00000000-0000-4000-8000-000000000002';
    (window as any).__desktopFixture.emit('backend-stream', 'connected');
  });
  await expect(panel.getByText('尚未配置仪器', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__desktopFixture.releaseDeviceReads());
  await expect(panel.getByRole('article', { name: 'Climber', exact: true })).toHaveCount(0);
  await expect(panel.getByText('尚未配置仪器', { exact: true })).toBeVisible();
});

for (const mode of ['unsupported', 'empty'] as const)
  test(`instrument monitor does not invent a device when capability or configuration is ${mode}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await nativeDesktop(page, false, 'ready', mode);
    await page.goto('/');
    await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
    if (mode === 'unsupported') {
      await expect(page.getByRole('button', { name: '仪器状态', exact: true })).toHaveCount(0);
      expect(
        await page.evaluate(() =>
          (window as any).__desktopTest.requests.filter((path: string) =>
            path.startsWith('/devices'),
          ),
        ),
      ).toEqual([]);
    } else {
      const panel = page.getByRole('complementary', { name: '仪器实时状态' });
      await expect(panel.getByText('尚未配置仪器', { exact: true })).toBeVisible();
      await expect(panel.locator('.instrument-monitor-device')).toHaveCount(0);
      await panel.getByRole('button', { name: '配置仪器', exact: true }).click();
      await expect(page.getByRole('heading', { name: '仪器', exact: true })).toBeVisible();
    }
  });

test('long conversations render a recent page and load earlier messages on upward scrolling without moving the reading anchor', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.evaluate(() => {
    const events: any[] = [{ type: 'session.started', data: {} }];
    for (let sequence = 0; sequence < 80; sequence++) {
      const turnId = `paged-turn-${sequence}`;
      events.push(
        { type: 'turn.started', data: { turnId, sequence } },
        { type: 'message.received', data: { turnId, sequence, message: `历史问题 ${sequence}` } },
        {
          type: 'message.completed',
          data: {
            turnId,
            sequence,
            stepIndex: 0,
            message: `历史回答 ${sequence}`,
            finishReason: 'stop',
          },
        },
        { type: 'turn.completed', data: { turnId, sequence } },
      );
    }
    (window as any).__desktopFixture.histories['wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB'] = events.map(
      (event, index) => ({
        ...event,
        meta: { id: `paged-event-${index}`, at: '2026-11-11T00:00:00Z' },
      }),
    );
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('历史回答 79', { exact: true })).toBeVisible();
  await expect(page.locator('.corax-message')).toHaveCount(20);
  await expect(page.getByText('历史问题 0', { exact: true })).toHaveCount(0);
  const first = page.locator('.corax-message').first();
  const anchor = await first.getAttribute('data-message-id');
  await page.evaluate(() => {
    const scroll = document.querySelector('.conversation')!;
    scroll.scrollTop = 0;
    (window as any).__readingAnchorTop = document
      .querySelector('[data-message-id]')!
      .getBoundingClientRect().top;
  });
  await expect(page.locator('.corax-message')).toHaveCount(40);
  const top = await page
    .locator('[data-message-id]')
    .evaluateAll(
      (elements, id) =>
        elements
          .find((element) => element.getAttribute('data-message-id') === id)!
          .getBoundingClientRect().top,
      anchor,
    );
  expect(
    Math.abs(top - (await page.evaluate(() => (window as any).__readingAnchorTop))),
  ).toBeLessThan(2);
  await expect(page.getByText('历史问题 60', { exact: true })).toBeVisible();
  await expect(page.getByText('历史问题 0', { exact: true })).toHaveCount(0);
  expect(await page.locator('.main-area').evaluate((element) => element.scrollTop)).toBe(0);
  const readingScroll = await page
    .locator('.conversation')
    .evaluate((element) => element.scrollTop);
  await page.evaluate(() => {
    const fixture = (window as any).__desktopFixture;
    const state = (window as any).__desktopTest;
    const id = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    const events = [
      { type: 'turn.started', data: { turnId: 'paged-turn-80', sequence: 80 } },
      {
        type: 'message.received',
        data: { turnId: 'paged-turn-80', sequence: 80, message: '历史问题 80' },
      },
      {
        type: 'message.completed',
        data: {
          turnId: 'paged-turn-80',
          sequence: 80,
          stepIndex: 0,
          message: '历史回答 80',
          finishReason: 'stop',
        },
      },
      { type: 'turn.completed', data: { turnId: 'paged-turn-80', sequence: 80 } },
    ].map((event, index) => ({
      ...event,
      meta: { id: `new-page-event-${index}`, at: '2026-11-11T00:00:01Z' },
    }));
    const startIndex = fixture.histories[id].length;
    fixture.histories[id].push(...events);
    fixture.emit('corax-events', {
      sessionId: id,
      watchId: state.watchRequests.at(-1).watchId,
      generation: state.generation,
      startIndex,
      events,
    });
  });
  await expect(page.locator('.corax-message')).toHaveCount(42);
  expect(await page.locator('.conversation').evaluate((element) => element.scrollTop)).toBe(
    readingScroll,
  );
  expect(
    Math.abs(
      (await page
        .locator('[data-message-id]')
        .evaluateAll(
          (elements, id) =>
            elements
              .find((element) => element.getAttribute('data-message-id') === id)!
              .getBoundingClientRect().top,
          anchor,
        )) - top,
    ),
  ).toBeLessThan(2);
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.locator('.corax-message')).toHaveCount(20);
  await expect(page.getByText('历史回答 79', { exact: true })).toBeVisible();
  await expect(page.getByText('历史回答 80', { exact: true })).toBeVisible();
});

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

test('session rename context menu edits the target without selecting it and persists the displayed title', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  const target = page.getByRole('button', { name: /^会话二/ });
  await target.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '会话操作' });
  await expect(menu).toBeVisible();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: /重命名/ }).click();
  const dialog = page.getByRole('dialog', { name: '重命名会话' });
  const input = dialog.getByRole('textbox', { name: '会话名称' });
  await expect(input).toBeFocused();
  await expect(input).toHaveClass(/ui-input/);
  await input.fill('我的测试方案');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: /^我的测试方案/ })).toBeVisible();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.renames)).toEqual([
    { id: 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TC', title: '我的测试方案' },
  ]);
  await page.getByRole('button', { name: /^我的测试方案/ }).click();
  await expect(page.locator('.content-caption')).toHaveText('我的测试方案');
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(page.getByRole('button', { name: /^我的测试方案/ })).toBeVisible();
});

test('session rename keyboard controls cancel without writes and retain edits after a failed save', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  const row = page.getByRole('button', { name: /^会话一/ });
  await row.focus();
  await row.press('Shift+F10');
  await expect(page.getByRole('menu', { name: '会话操作' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row).toBeFocused();
  await row.press('F2');
  const dialog = page.getByRole('dialog', { name: '重命名会话' });
  const input = dialog.getByRole('textbox', { name: '会话名称' });
  await input.fill('  ');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await input.fill('x'.repeat(101));
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await input.fill('需要保留的名称');
  await page.evaluate(() => {
    (window as any).__desktopTest.failRename = true;
  });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('保存失败');
  await expect(input).toHaveValue('需要保留的名称');
  await expect(row).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.renames.length)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(row).toBeFocused();
});

test('session rename survives an older pending list refresh and the context menu stays inside the viewport', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  const row = page.getByRole('button', { name: /^会话一/ });
  await row.dispatchEvent('contextmenu', { clientX: 1278, clientY: 858 });
  const menu = page.getByRole('menu', { name: '会话操作' });
  await expect(menu).toBeVisible();
  const bounds = (await menu.boundingBox())!;
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1272);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(852);
  await page.keyboard.press('Escape');
  const count = await page.evaluate(
    () =>
      (window as any).__desktopTest.requests.filter((path: string) => path.startsWith('/session?'))
        .length,
  );
  await page.evaluate(() => {
    (window as any).__desktopTest.holdList = true;
    (window as any).__desktopFixture.emit('agent-event', {
      sessionId: 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB',
      type: 'session.updated',
      properties: {},
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__desktopTest.requests.filter((path: string) =>
            path.startsWith('/session?'),
          ).length,
      ),
    )
    .toBe(count + 1);
  await row.focus();
  await row.press('F2');
  const dialog = page.getByRole('dialog', { name: '重命名会话' });
  await dialog.getByRole('textbox', { name: '会话名称' }).fill('刷新后仍保留的名称');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.evaluate(() => (window as any).__desktopFixture.releaseList());
  await expect(page.getByRole('button', { name: /^刷新后仍保留的名称/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^会话一/ })).not.toBeVisible();
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

test('first-message initialization is silent until the native assistant message arrives', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await expect(page.locator('.app')).toHaveAttribute('data-backend-state', 'connected');
  await page.evaluate(() => {
    (window as any).__desktopTest.holdHistoryFor = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    const statuses: string[] = [];
    (window as any).__beforeAssistantStatuses = statuses;
    const observer = new MutationObserver(() => {
      if (document.querySelector('.message.assistant')) return;
      for (const status of document.querySelectorAll('.chat-activity'))
        statuses.push(status.textContent ?? '');
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    (window as any).__firstMessageObserver = observer;
  });
  await page.getByRole('textbox', { name: '输入消息' }).fill('验证首次提交不闪现过渡文字');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.requests.some(
          (path: string) => path.startsWith('/session/') && path.split('?')[0].endsWith('/events'),
        ),
      ),
    )
    .toBe(true);
  try {
    await expect(page.locator('.message.assistant')).toHaveCount(0);
    await expect(page.locator('.chat-activity')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  } finally {
    await page.evaluate(() => (window as any).__desktopFixture.releaseHistory());
  }
  await expect(page.getByText('Corax 原生连接成功。', { exact: true })).toBeVisible();
  const statuses = await page.evaluate(() => {
    (window as any).__firstMessageObserver.disconnect();
    return (window as any).__beforeAssistantStatuses as string[];
  });
  expect(statuses).toEqual([]);
  expect(await page.evaluate(() => (window as any).__desktopTest.backendStarts)).toBe(1);
});

test('an uncached history displays its tail while canonical synchronization still gates all writes', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).__desktopTest.holdHistoryFor = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await expect(page.locator('.chat-activity')).toHaveCount(0);
  await page.getByRole('textbox', { name: '输入消息' }).fill('等状态确认后再发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__desktopTest.watchRequests.length)).toBe(0);
  expect(
    await page.evaluate(() =>
      (window as any).__desktopTest.requests.some((path: string) =>
        path.endsWith('/events?tail=512'),
      ),
    ),
  ).toBe(true);
  await page.evaluate(() => (window as any).__desktopFixture.releaseHistory());
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
});

test('unfinished fragments expand the tail budget without inventing a completed reply', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.evaluate(() => {
    const id = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    const state = (window as any).__desktopTest;
    const history = (window as any).__desktopFixture.histories[id];
    const turn = { turnId: 'turn-1', sequence: 0, stepIndex: 0 };
    history.splice(
      3,
      0,
      ...Array.from({ length: 900 }, (_, index) => ({
        type: 'message.appended',
        data: { ...turn, messageDelta: 'fixture ' },
        meta: { id: `chunk-${index}`, at: '2026-11-11T00:00:00Z' },
      })),
    );
    history.splice(
      history.findIndex((event: any) => event.type === 'message.completed'),
      1,
    );
    history.at(-1).type = 'turn.cancelled';
    state.holdHistoryFor = id;
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的问题', { exact: true })).toBeVisible();
  const reads = await page.evaluate(() =>
    (window as any).__desktopTest.requests.filter((path: string) => path.includes('/events?tail=')),
  );
  expect(reads.some((path: string) => path.endsWith('tail=512'))).toBe(true);
  expect(reads.some((path: string) => path.endsWith('tail=2048'))).toBe(true);
  await page.getByRole('textbox', { name: '输入消息' }).fill('尚未同步不能发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__desktopFixture.releaseHistory());
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
});

test('a completed reply inside a long turn appears before full history without searching repeatedly for its turn start', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.evaluate(() => {
    const id = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    const state = (window as any).__desktopTest;
    const history = (window as any).__desktopFixture.histories[id];
    history.splice(
      3,
      0,
      ...Array.from({ length: 3000 }, (_, index) => ({
        type: 'message.appended',
        data: { turnId: 'turn-1', sequence: 0, stepIndex: 0, messageDelta: 'fragment ' },
        meta: { id: `long-${index}`, at: '2026-11-11T00:00:00Z' },
      })),
    );
    state.holdPreviewFor = state.holdHistoryFor = id;
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.requests.some((path: string) =>
          path.endsWith('/events?tail=512'),
        ),
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(() =>
      (window as any).__desktopTest.requests.some(
        (path: string) => path === '/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events',
      ),
    ),
  ).toBe(false);
  await page.evaluate(() => (window as any).__desktopFixture.releasePreviewReads());
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await expect(page.locator('.history-preview-status')).toContainText('最近回复预览');
  await page.getByRole('textbox', { name: '输入消息' }).fill('预览不能授权发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  expect(
    await page.evaluate(
      () =>
        (window as any).__desktopTest.requests.filter((path: string) =>
          path.includes('/events?tail='),
        ).length,
    ),
  ).toBe(1);
  await page.evaluate(() => (window as any).__desktopFixture.releaseHistory());
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await expect(page.locator('.history-preview-status')).toHaveCount(0);
  await expect(page.getByText('会话一的问题', { exact: true })).toBeVisible();
});

test('a tail that is a verified complete prefix is synchronized without reading the same full history again', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).__desktopTest.confirmCompleteTail = true;
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息' }).fill('完整原生前缀可恢复就绪');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(
    await page.evaluate(() =>
      (window as any).__desktopTest.requests.filter(
        (path: string) => path === '/session/wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB/events',
      ),
    ),
  ).toEqual([]);
  expect(await page.evaluate(() => (window as any).__desktopTest.watchRequests.length)).toBe(1);
});

test('an optional tail failure falls back to canonical loading without replaying a write', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).__desktopTest.failPreview = true;
    (window as any).__desktopTest.holdHistoryFor = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect(page.locator('.chat-activity')).toContainText('正在读取会话');
  await expect(page.getByText('会话一的回复', { exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__desktopFixture.releaseHistory());
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).__desktopTest.requests.filter((path: string) =>
        path.endsWith('/prompt_async'),
      ),
    ),
  ).toEqual([]);
});

test('late tail preview responses cannot replace another selected conversation', async ({
  page,
}) => {
  await nativeDesktop(page, true);
  await page.goto('/');
  await page.evaluate(() => {
    const state = (window as any).__desktopTest;
    state.holdHistoryFor = state.holdPreviewFor = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
  });
  await page.getByRole('button', { name: /^会话一/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__desktopTest.requests.some((path: string) =>
          path.endsWith('/events?tail=512'),
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: /^会话二/ }).click();
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__desktopFixture.releaseHistory();
    (window as any).__desktopFixture.releasePreviewReads();
  });
  await expect(page.getByText('会话二的回复', { exact: true })).toBeVisible();
  await expect(page.getByText('会话一的回复', { exact: true })).toHaveCount(0);
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
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await openKnowledgeSources(page);
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
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await openKnowledgeSources(page);
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
  await page.getByRole('tab', { name: '图谱', exact: true }).click();
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
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await openKnowledgeSources(page);
  await page.getByRole('button', { name: '添加文件', exact: true }).click();
  const start = page.getByRole('button', { name: '开始整理', exact: true });
  await expect(start).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts.length)).toBe(0);
  await expect(page.getByText('待整理', { exact: true })).toBeVisible();
  await start.click();
  await expect(page.getByText('分析资料', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '图谱', exact: true }).click();
  await page.locator('.settings-menu').getByRole('button', { name: '模型', exact: true }).click();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await openKnowledgeSources(page);
  await expect(page.getByText('分析资料', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__desktopFixture.finishKnowledge('completed', 1));
  await expect(page.getByText('整理完成', { exact: true })).toBeVisible();
  await expect(page.getByText('已整理', { exact: true })).toBeVisible();
  await openKnowledgeDirectory(page);
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
  await page.getByRole('button', { name: '关闭知识页内容', exact: true }).click();
  await openKnowledgeSources(page);
  await page.getByRole('button', { name: '移除 C:\\fixtures\\notes.md', exact: true }).click();
  await openKnowledgeDirectory(page);
  await expect(page.getByRole('button', { name: /^整理后的笔记/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts.length)).toBe(1);
});

test('cancelling knowledge compilation waits for a terminal result and reports completed publications', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await openKnowledgeSources(page);
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
  await openKnowledgeDirectory(page);
  await expect(page.getByRole('button', { name: /^整理后的笔记/ })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts.length)).toBe(1);
});

test('knowledge compilation waits for applied settings and never replays an uncertain start', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await openKnowledgeSources(page);
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
  await page.getByRole('button', { name: '刷新资料状态', exact: true }).click();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(
    page.getByText('整理请求结果尚未确认，未自动重试。请刷新并核对已发布内容。', { exact: true }),
  ).toBeVisible();
  await expect(start).toBeDisabled();
  await page.getByRole('button', { name: '刷新资料状态', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts.length)).toBe(1);
});

test('knowledge workspace uses wide columns and real published links for keyboard-accessible reading', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nativeDesktop(page);
  await page.goto('/');
  await page.evaluate(() => (window as any).__desktopFixture.publishKnowledge());
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await expect(page.locator('.knowledge-sidebar')).toBeVisible();
  await expect(page.locator('.settings-menu')).toBeVisible();
  const graphBounds = await page.locator('.knowledge-main').boundingBox();
  const readerBounds = await page.locator('.knowledge-reader-panel').boundingBox();
  expect(readerBounds!.x).toBeGreaterThanOrEqual(graphBounds!.x + graphBounds!.width - 1);
  expect(Math.abs(readerBounds!.y - graphBounds!.y)).toBeLessThan(2);
  expect(graphBounds!.height).toBeGreaterThan(500);
  await expect(page.getByRole('tab', { name: '资料', exact: true })).toBeVisible();
  await expect(page.locator('.knowledge-graph-node')).toHaveCount(1);
  await expect(page.locator('.knowledge-graph-edge')).toHaveCount(0);
  await openKnowledgeDirectory(page);
  await page.getByRole('button', { name: '显示更多知识页', exact: true }).click();
  await expect(page.locator('.knowledge-graph-node')).toHaveCount(2);
  await expect(page.locator('.knowledge-graph-edge')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('knowledge-catalog.png') });
  await page.getByRole('tab', { name: '图谱', exact: true }).click();
  const node = page.getByRole('button', { name: '查看知识页：整理后的笔记', exact: true });
  await node.focus();
  await page.keyboard.press('Enter');
  const reader = page.getByRole('region', { name: '知识页内容', exact: true });
  await expect(reader.getByText('这是有来源的知识正文。', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('knowledge-wide.png') });
  await page.getByRole('button', { name: '专注图谱', exact: true }).click();
  await expect(reader).not.toBeVisible();
  await expect(page.locator('.settings-menu')).toBeVisible();
  expect((await page.locator('.knowledge-main').boundingBox())!.width).toBeGreaterThan(
    graphBounds!.width + 100,
  );
  await page.getByRole('button', { name: '退出图谱专注', exact: true }).click();
  await expect(reader).toBeVisible();
  await reader.getByRole('button', { name: '额外知识页', exact: true }).click();
  await expect(reader.getByRole('heading', { name: '额外知识页', exact: true })).toBeVisible();
  await reader.getByRole('button', { name: '关闭知识页内容', exact: true }).click();
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible();
  await openKnowledgeDirectory(page);
  await page.getByRole('searchbox', { name: '搜索已加载知识页', exact: true }).fill('额外');
  await expect(page.locator('.knowledge-page-link')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts)).toEqual([]);
  const references = await page.evaluate(() => (window as any).__desktopTest.knowledgeReads);
  expect(references.map((reference: any) => reference.path)).toEqual([
    'concepts/notes.md',
    'concepts/extra.md',
  ]);
  expect(
    references.every(
      (reference: any) => reference.generation === '00000000-0000-4000-8000-000000000099',
    ),
  ).toBe(true);
});

test('knowledge tabs animate pointer changes, respect immediate navigation and keep readable text contrast', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__knowledgeMotion = [];
    document.querySelector('.knowledge-base')!.addEventListener('transitionrun', (event) => {
      const transition = event as TransitionEvent;
      if (
        (transition.propertyName === 'transform' || transition.propertyName === 'opacity') &&
        (transition.target as Element).matches('.knowledge-view-tabs, .knowledge-view')
      )
        (window as any).__knowledgeMotion.push(transition.propertyName);
    });
  });
  const waitForMotion = () =>
    expect
      .poll(() =>
        page
          .locator('.knowledge-base')
          .evaluate(
            (element) =>
              element
                .getAnimations({ subtree: true })
                .filter((animation) => animation.playState === 'running').length,
          ),
      )
      .toBe(0);
  const nextFrames = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  const checkContrast = async (selectors: string) => {
    const values = await page.locator('.knowledge-base').evaluate((root, selectors) => {
      const rgb = (color: string) => color.match(/[\d.]+/g)!.map(Number);
      const luminance = (color: string) => {
        const [r, g, b] = rgb(color)
          .slice(0, 3)
          .map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
        return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
      };
      return [...root.querySelectorAll(selectors)].map((element) => {
        let parent: Element | null = element;
        let background = 'rgb(255, 255, 255)';
        while (parent) {
          const color = getComputedStyle(parent).backgroundColor;
          if ((rgb(color)[3] ?? 1) === 1) {
            background = color;
            break;
          }
          parent = parent.parentElement;
        }
        const a = luminance(getComputedStyle(element).color),
          b = luminance(background);
        return {
          label: element.textContent,
          ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        };
      });
    }, selectors);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values)
      expect(value.ratio, value.label ?? selectors).toBeGreaterThanOrEqual(4.5);
  };
  await page.getByRole('tab', { name: '目录', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__knowledgeMotion))
    .toEqual(expect.arrayContaining(['transform', 'opacity']));
  await waitForMotion();
  await checkContrast('.knowledge-view-tabs .ui-button, .knowledge-catalog-tools > span');
  await page.getByRole('tab', { name: '资料', exact: true }).click();
  await waitForMotion();
  await checkContrast(
    '.knowledge-source-help, .knowledge-source-footnote, .knowledge-source-header-actions > span',
  );
  await page.evaluate(() => {
    (window as any).__knowledgeMotion = [];
  });
  await page.getByRole('tab', { name: '资料', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: '目录', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await nextFrames();
  expect(await page.evaluate(() => (window as any).__knowledgeMotion)).toEqual([]);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('tab', { name: '图谱', exact: true }).click();
  await nextFrames();
  expect(await page.evaluate(() => (window as any).__knowledgeMotion)).toEqual([]);
});

test('knowledge view tabs switch in place without cancelling work or changing the settings sidebar', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 900, height: 860 });
  await nativeDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await expect(page.locator('.knowledge-sidebar')).not.toBeVisible();
  const initialBounds = await page.locator('.knowledge-main').boundingBox();
  const settingsWidth = (await page.locator('.session-sidebar').boundingBox())!.width;
  const emptyIconWidth = await page
    .locator('.knowledge-graph-empty svg')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(emptyIconWidth).toBeGreaterThan(0);
  expect(emptyIconWidth).toBeLessThan(80);
  await page.getByRole('tab', { name: '图谱', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '目录', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: '资料', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const drawer = await openKnowledgeSources(page);
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('内置参考资料', { exact: true })).toHaveCount(0);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('.settings-menu')).toBeVisible();
  expect((await page.locator('.knowledge-main').boundingBox())!.width).toBe(initialBounds!.width);
  expect((await page.locator('.session-sidebar').boundingBox())!.width).toBe(settingsWidth);
  await expect(page.locator('.knowledge-navigation')).toHaveCount(0);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(false);
  await drawer.getByRole('button', { name: '添加文件', exact: true }).click();
  await expect(drawer.getByRole('button', { name: '开始整理', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('knowledge-narrow.png') });
  await page.setViewportSize({ width: 640, height: 860 });
  await expect(page.getByRole('heading', { name: '知识库', exact: true })).toBeVisible();
  const heading = await page.locator('.knowledge-view-heading').boundingBox();
  const tabs = await page.getByRole('tablist', { name: '知识库视图' }).boundingBox();
  const title = await page.getByRole('heading', { name: '知识库', exact: true }).boundingBox();
  expect(tabs!.y).toBeGreaterThan(title!.y + title!.height);
  expect(tabs!.x).toBeGreaterThanOrEqual(heading!.x);
  expect(tabs!.x + tabs!.width).toBeLessThanOrEqual(heading!.x + heading!.width);
  expect(
    await page
      .locator('.knowledge-base')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await expect(drawer.getByRole('button', { name: '添加文件夹', exact: true })).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('knowledge-compact.png') });
  await page.setViewportSize({ width: 900, height: 860 });
  await drawer.getByRole('button', { name: '开始整理', exact: true }).click();
  await expect(drawer.getByText('分析资料', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '图谱', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.locator('.knowledge-workspace-status')).toContainText('资料整理进行中');
  await openKnowledgeSources(page);
  await drawer.getByRole('button', { name: '取消整理', exact: true }).click();
  await page.evaluate(() => (window as any).__desktopFixture.finishKnowledge('cancelled', 1));
  await expect(drawer.getByText('整理已取消', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(drawer).toBeVisible();
  await expect(page.locator('.knowledge-sidebar')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('knowledge-sources-wide.png') });
  await openKnowledgeDirectory(page);
  await page.getByRole('button', { name: /^整理后的笔记/ }).click();
  await expect(
    page
      .getByRole('region', { name: '知识页内容' })
      .getByText('这是有来源的知识正文。', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 900, height: 860 });
  const readerDrawer = page.getByRole('region', { name: '知识页内容', exact: true });
  await expect(readerDrawer.getByText('这是有来源的知识正文。', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(readerDrawer).toBeVisible();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: '知识页内容' })
      .getByText('这是有来源的知识正文。', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).__desktopTest.knowledgeStarts.length)).toBe(1);
});

test('late knowledge preview responses cannot overwrite a more recently selected fixed reference', async ({
  page,
}) => {
  await nativeDesktop(page);
  await page.goto('/');
  await page.evaluate(() => {
    (window as any).__desktopFixture.publishKnowledge();
    (window as any).__desktopTest.holdKnowledgeReadFor = 'concepts/notes.md';
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '知识库', exact: true }).click();
  await openKnowledgeDirectory(page);
  await page.getByRole('button', { name: '显示更多知识页', exact: true }).click();
  await page.getByRole('button', { name: /^整理后的笔记/ }).click();
  const reader = page.getByRole('region', { name: '知识页内容', exact: true });
  await expect(reader.getByText('正在读取知识页…', { exact: true })).toBeVisible();
  await reader.getByRole('button', { name: '额外知识页', exact: true }).click();
  await expect(reader.getByRole('heading', { name: '额外知识页', exact: true })).toBeVisible();
  await expect(reader.getByText('这是有来源的知识正文。', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__desktopFixture.releaseKnowledgeReads());
  await expect(reader.getByRole('heading', { name: '额外知识页', exact: true })).toBeVisible();
  await expect(reader.locator('.knowledge-reader-reference')).toContainText('concepts/extra.md');
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
  await expect(page.getByText('会话一的回复', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息' }).fill('切换前不能从尾部预览发送');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
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
    const state = (window as any).__desktopTest;
    const fixture = (window as any).__desktopFixture;
    state.generation = '00000000-0000-4000-8000-000000000002';
    state.holdHistoryFor = 'wrun_01M6JWQZ0A0QH6MERWTZ96Z7TB';
    for (const event of fixture.histories[state.holdHistoryFor]) {
      if (event.type === 'message.completed') event.data.message = '新后端的会话一回复';
    }
    fixture.emit('backend-stream', 'connected');
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
  await expect(page.getByText('新后端的会话一回复', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '输入消息' }).fill('新后端仍需同步状态');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
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
  await expect(page.getByText('新后端的会话一回复', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
});
