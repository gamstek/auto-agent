import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import type { ModelMessage } from 'ai';
import type { Config } from '../config';
import { Skills } from '../skill';
import { escapeXml, skillGuidance } from '../skill/prompt';
import { ScriptExecutor } from '../execution';
import { Store } from '../storage';
import { SQLiteSaver } from '../storage/checkpointer';
import { BuiltinToolRegistry, UncertainToolError, type ToolContext } from '../tool';
import { toolGuidance } from '../tool/prompt';
import { Wiki } from '../wiki';
import {
  AppError,
  errorText,
  requireTokenUsage,
  type ModelAdapter,
  type ModelTurn,
  type Message,
} from '../shared/types';
import { Events } from './events';
import { DEFAULT_SYSTEM_PROMPT } from './prompt';
import { builtinInstructions } from './builtins';
import { fitModelContext } from './context';
import { Diagnostics } from '../shared/diagnostics';
const State = Annotation.Root({
  messages: Annotation<ModelMessage[]>(),
  turn: Annotation<ModelTurn>(),
  steps: Annotation<number>(),
  tokens: Annotation<number>(),
  loaded: Annotation<string[]>(),
});
export class AgentService {
  readonly events = new Events();
  private readonly toolRegistry = new BuiltinToolRegistry();
  private active = new Map<
    string,
    { controller: AbortController; done: Promise<Message>; completed: boolean }
  >();
  private titles = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;
  private wikiUpdate?: {
    controller: AbortController;
    done: Promise<{ sources: number; rebuilt: number; builtAt: number }>;
  };
  get wiki(): Wiki {
    return this.wikiService;
  }
  private wikiIndexUpdate?: { controller: AbortController; done: ReturnType<Wiki['indexSources']> };
  updateWikiIndex(signal: AbortSignal): ReturnType<Wiki['indexSources']> {
    if (this.closing) throw new AppError('shutdown', 'Agent is shutting down', 503);
    if (this.wikiIndexUpdate)
      throw new AppError('wiki_index_busy', 'Wiki source index update already running', 409);
    const controller = new AbortController();
    const done = this.wiki
      .indexSources(AbortSignal.any([signal, controller.signal]))
      .catch((error) => {
        if (signal.aborted || controller.signal.aborted)
          throw new AppError(
            'cancelled',
            'Wiki source index update cancelled; previous index retained',
            409,
          );
        throw error;
      })
      .finally(() => {
        this.wikiIndexUpdate = undefined;
      });
    this.wikiIndexUpdate = { controller, done };
    return done;
  }
  updateWiki(signal: AbortSignal): Promise<{ sources: number; rebuilt: number; builtAt: number }> {
    if (this.closing) throw new AppError('shutdown', 'Agent is shutting down', 503);
    if (this.wikiUpdate) throw new AppError('wiki_busy', 'Knowledge update already running', 409);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const done = this.wiki
      .update(this.model, combined)
      .catch((error) => {
        if (combined.aborted)
          throw new AppError(
            'cancelled',
            'Knowledge update cancelled; previous snapshot retained',
            409,
          );
        throw error;
      })
      .finally(() => {
        this.wikiUpdate = undefined;
      });
    this.wikiUpdate = { controller, done };
    return done;
  }
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly skills: Skills,
    private executor: ScriptExecutor,
    private model: ModelAdapter,
    readonly diagnostics = new Diagnostics(config.dataDir, [config.apiKey ?? '', config.token]),
  ) {
    this.wikiService = new Wiki(config, store.db);
  }
  private readonly wikiService: Wiki;
  review(sessionId: string) {
    const pending = this.store.pendingReview(sessionId);
    return {
      pending: JSON.parse(this.redact(JSON.stringify(pending))) as typeof pending,
      logs: this.diagnostics.paths(),
    };
  }
  private reviewText(sessionId: string): string {
    const { pending, logs } = this.review(sessionId);
    if (!pending)
      return this.redact(
        `No operator review is pending for this session.\nAgent log: ${logs.agent}\nSkill log: ${logs.skills}`,
      );
    const lines = [`等待对账 / Operator review required`, `Run: ${pending.id}`];
    for (const execution of pending.executions.filter((item) => item.status === 'unknown')) {
      lines.push(
        `Execution: ${execution.id}`,
        `Script: ${execution.skill} / ${execution.path}`,
        `Exit code: ${execution.exitCode ?? 'unconfirmed'}`,
      );
      if (execution.diagnostic) {
        const detail = execution.diagnostic;
        const request =
          detail.diagnostic && typeof detail.diagnostic === 'object'
            ? (detail.diagnostic as Record<string, unknown>)
            : {};
        for (const [label, value] of Object.entries({
          Code: detail.code,
          Reason: detail.message,
          Batch: detail.batchId,
          Stage: detail.stage,
          HTTP: detail.status,
          Phase: request.reason ?? request.phase,
          DurationMs: request.durationMs,
          Cause: request.cause ? JSON.stringify(request.cause) : undefined,
        }))
          if (value !== undefined) lines.push(`${label}: ${String(value)}`);
      } else
        lines.push(
          '该执行未保留结构化错误（旧版本或进程中断）；请查看技能日志，不能据此推断仪器启动失败或成功。',
        );
    }
    lines.push(
      `Agent log: ${logs.agent}`,
      `Skill log: ${logs.skills}`,
      '仅显示诊断，不会重放脚本或解除待对账状态。核对厂家当前状态及批次后，可由操作者使用 /resolve <runId> <核对说明> 记录处理结果。',
    );
    return this.redact(lines.join('\n'));
  }
  reviewMessage(sessionId: string): Message {
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: 'assistant',
      content: this.reviewText(sessionId),
      createdAt: Date.now(),
    };
  }
  resolveReview(sessionId: string, runId: string, note: string): Message {
    if (this.active.has(sessionId))
      throw new AppError('session_busy', 'Session already has an active generation', 409);
    const safeNote = this.redact(note);
    this.store.resolveReview(sessionId, runId, safeNote);
    this.diagnostics.write('agent', 'review.resolved', { sessionId, runId, note: safeNote });
    return this.store.addMessage(
      sessionId,
      'assistant',
      `Operator review recorded for ${runId}. The interrupted run remains failed and its executions retain their original unknown status. This does not confirm equipment stopped.\nReview: ${safeNote}`,
    );
  }
  submit(sessionId: string, content: string): Promise<Message> {
    this.store.getSession(sessionId);
    if (this.closing) throw new AppError('shutdown', 'Agent is shutting down', 503);
    if (!content.trim() || Buffer.byteLength(content) > this.config.requestLimitBytes)
      throw new AppError('invalid_message', 'Message is empty or too large');
    if (this.active.has(sessionId))
      throw new AppError('session_busy', 'Session already has an active generation', 409);
    if (this.store.pendingReview(sessionId)) {
      const reply = this.store.db
        .transaction(() => {
          this.store.addMessage(sessionId, 'user', this.redact(content));
          return this.store.addMessage(sessionId, 'assistant', this.reviewText(sessionId));
        })
        .immediate();
      this.diagnostics.write('agent', 'review.reported', { sessionId });
      this.events.publish({
        type: 'message.completed',
        sessionId,
        messageId: reply.id,
        properties: { message: reply },
      });
      return Promise.resolve(reply);
    }
    if (this.active.size >= this.config.maxConcurrent)
      throw new AppError('capacity', 'Agent concurrency budget exhausted', 429);
    const messageId = crypto.randomUUID();
    const safeContent = this.redact(content);
    const runId = this.store.db
      .transaction(() => {
        const user = this.store.addMessage(sessionId, 'user', safeContent);
        return this.store.beginRun(sessionId, user.id);
      })
      .immediate();
    const controller = new AbortController();
    const done = this.run(sessionId, messageId, runId, controller.signal)
      .finally(() => this.active.delete(sessionId))
      .then((reply) => {
        this.startTitle(sessionId, reply);
        return reply;
      });
    this.active.set(sessionId, { controller, done, completed: false });
    return done;
  }
  private redact(text: string): string {
    for (const secret of [this.config.apiKey, this.config.token])
      if (secret) text = text.split(secret).join('[redacted]');
    return text;
  }
  async abort(sessionId: string): Promise<boolean> {
    this.store.getSession(sessionId);
    const active = this.active.get(sessionId);
    if (!active || active.completed) return false;
    active.controller.abort();
    await active.done.catch(() => {});
    return true;
  }
  async shutdown(): Promise<void> {
    this.diagnostics.write('agent', 'service.stopping');
    this.closing = true;
    this.wikiUpdate?.controller.abort();
    this.wikiIndexUpdate?.controller.abort();
    const wikiDone = this.wikiUpdate?.done;
    for (const entry of [...this.active.values(), ...this.titles.values()])
      entry.controller.abort();
    await Promise.allSettled([
      ...[...this.active.values(), ...this.titles.values()].map((v) => v.done),
      ...(wikiDone ? [wikiDone] : []),
      ...(this.wikiIndexUpdate ? [this.wikiIndexUpdate.done] : []),
    ]);
    this.wiki.close();
    this.diagnostics.write('agent', 'service.stopped');
  }
  private startTitle(sessionId: string, reply: Message): void {
    if (
      this.closing ||
      this.titles.has(sessionId) ||
      this.titles.size >= this.config.maxConcurrent ||
      !this.model.generateTitle ||
      !this.store.needsTitle(sessionId)
    )
      return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.min(this.config.modelTimeoutMs, 15000)),
    ]);
    const emit = (type: string, properties: Record<string, unknown> = {}) =>
      this.events.publish({ type, sessionId, messageId: reply.id, properties });
    const done = Promise.resolve()
      .then(async () => {
        emit('session.title.started');
        let abort: (() => void) | undefined;
        try {
          const generated = await Promise.race([
            this.model.generateTitle!(
              [
                { role: 'user', content: this.store.firstUserContent(sessionId) },
                { role: 'assistant', content: reply.content.slice(0, 2000) },
              ],
              signal,
            ),
            new Promise<never>((_, reject) => {
              abort = () => reject(signal.reason);
              if (signal.aborted) abort();
              else signal.addEventListener('abort', abort, { once: true });
            }),
          ]);
          if (signal.aborted) return;
          const title = [
            ...this.redact(generated)
              .replace(/[\x00-\x1f\x7f]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .replace(/^["'`]+|["'`]+$/g, ''),
          ]
            .slice(0, 60)
            .join('');
          if (!title) throw new AppError('empty_title', 'Model returned an empty title');
          if (this.store.setGeneratedTitle(sessionId, title))
            emit('session.updated', { session: this.store.getSession(sessionId) });
        } catch {
          emit('session.title.failed', {
            message: 'Session title generation failed; it will be retried on a later message.',
          });
        } finally {
          if (abort) signal.removeEventListener('abort', abort);
        }
      })
      .finally(() => this.titles.delete(sessionId));
    this.titles.set(sessionId, { controller, done });
  }
  private async run(
    sessionId: string,
    messageId: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<Message> {
    const emit = (type: string, properties: Record<string, unknown> = {}) => {
      if (!['message.part.delta', 'message.reasoning.delta', 'message.completed'].includes(type))
        this.diagnostics.write('agent', type, { ...properties, sessionId, messageId, runId });
      this.events.publish({ type, sessionId, messageId, properties });
    };
    const redact = (text: string) => this.redact(text);
    const failedScripts = new Set<string>();
    let uncertain = false;
    const check = () => {
      if (signal.aborted) throw new AppError('cancelled', 'Generation cancelled');
    };
    const graph = new StateGraph(State)
      .addNode('model', async (state) => {
        check();
        if (state.steps >= this.config.maxSteps)
          throw new AppError(
            'budget',
            `Agent step budget exhausted (${state.steps}/${this.config.maxSteps}). Split the workflow or increase maxSteps; no additional tools were executed.`,
          );
        let modelSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(this.config.modelTimeoutMs),
        ]);
        const modelStarted = Date.now();
        emit('model.started', { step: state.steps + 1 });
        const secrets = [this.config.apiKey, this.config.token].filter((value): value is string =>
          Boolean(value),
        );
        const deltaChannel = (event: string) => {
          let pending = '';
          let emitted = false;
          const flush = (final = false) => {
            if (modelSignal.aborted) return;
            let retain = 0;
            if (!final)
              for (const secret of secrets)
                for (let size = 1; size < secret.length; size++) {
                  if (pending.endsWith(secret.slice(0, size))) retain = Math.max(retain, size);
                }
            const safe = pending.slice(0, pending.length - retain);
            pending = retain ? pending.slice(-retain) : '';
            if (safe) {
              emitted = true;
              emit(event, { delta: safe, step: state.steps + 1 });
            }
          };
          return {
            write: (text: string) => {
              if (modelSignal.aborted) return;
              pending = redact(pending + text);
              flush();
            },
            flush,
            hasEmitted: () => emitted,
          };
        };
        const textDeltas = deltaChannel('message.part.delta');
        const reasoningDeltas = deltaChannel('message.reasoning.delta');
        let rawTurn: ModelTurn;
        let preparedMessages = state.messages;
        let summaryTokens = 0;
        try {
          let builtins = await builtinInstructions({ signal: modelSignal });
          let guidance = skillGuidance(this.skills.list());
          for (const secret of [this.config.apiKey, this.config.token]) {
            if (!secret) continue;
            builtins = builtins.split(escapeXml(secret)).join('[redacted]');
            guidance = guidance.split(escapeXml(secret)).join('[redacted]');
          }
          const modelMessages: ModelMessage[] = [
            ...state.messages.filter((message) => message.role === 'system'),
            { role: 'system', content: redact(builtins) },
            { role: 'system', content: redact(guidance) },
            ...state.messages.filter((message) => message.role !== 'system'),
          ];
          const context = await fitModelContext(
            modelMessages,
            this.config.maxInputTokens,
            this.toolRegistry.contextTokenEstimate(),
            {
              signal,
              summarize: this.model.summarize
                ? async (messages, caller) => {
                    const summarySignal = AbortSignal.any([
                      caller,
                      AbortSignal.timeout(this.config.modelTimeoutMs),
                    ]);
                    const safeMessages = JSON.parse(redact(JSON.stringify(messages)));
                    try {
                      const result = await this.model.summarize!(safeMessages, summarySignal);
                      summarySignal.throwIfAborted();
                      return { ...result, text: redact(result.text) };
                    } catch (error) {
                      if (!caller.aborted && summarySignal.aborted)
                        throw new AppError(
                          'context_timeout',
                          'Context summary model request timed out; history was retained and dependent tools were not executed.',
                        );
                      throw error;
                    }
                  }
                : undefined,
              onSummary: (details) => {
                summaryTokens += details.totalTokens;
                emit('context.compressed', {
                  ...details,
                  inputTokenLimit: this.config.maxInputTokens,
                  maxOutputTokens: this.config.maxOutputTokens,
                  runTokens: state.tokens + summaryTokens,
                });
              },
            },
          );
          preparedMessages = [
            ...state.messages.filter((message) => message.role === 'system'),
            ...context.messages.filter((message) => message.role !== 'system'),
          ];
          emit('context.prepared', {
            estimatedInputTokens: context.estimatedTokens,
            maxInputTokens: this.config.maxInputTokens,
          });
          modelSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.modelTimeoutMs)]);
          rawTurn = await this.model.generate(
            context.messages,
            modelSignal,
            textDeltas.write,
            reasoningDeltas.write,
          );
          modelSignal.throwIfAborted();
          requireTokenUsage(rawTurn.usage);
        } catch (error) {
          const failure =
            !signal.aborted && modelSignal.aborted && !(error instanceof AppError)
              ? new AppError(
                  'model_timeout',
                  `Model request timed out after ${this.config.modelTimeoutMs} ms. No additional tools were executed; verify the last recorded device/task state before continuing.`,
                  504,
                )
              : error;
          emit('model.failed', {
            step: state.steps + 1,
            status: signal.aborted
              ? 'cancelled'
              : failure instanceof AppError && failure.code === 'model_timeout'
                ? 'timeout'
                : 'failed',
            code: failure instanceof AppError ? failure.code : 'model_error',
            message: errorText(failure),
            durationMs: Date.now() - modelStarted,
          });
          throw failure;
        }
        reasoningDeltas.flush(true);
        textDeltas.flush(true);
        const turn: ModelTurn = JSON.parse(redact(JSON.stringify(rawTurn)));
        if (turn.reasoning && !reasoningDeltas.hasEmitted())
          emit('message.reasoning.delta', { delta: redact(turn.reasoning), step: state.steps + 1 });
        if (turn.text && !textDeltas.hasEmitted())
          emit('message.part.delta', { delta: turn.text, step: state.steps + 1 });
        const totalTokens = requireTokenUsage(turn.usage);
        emit('model.completed', {
          step: state.steps + 1,
          usage: turn.usage,
          totalTokens,
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
          runTokens: state.tokens + summaryTokens + totalTokens,
          durationMs: Date.now() - modelStarted,
        });
        check();
        const assistant: ModelMessage = {
          role: 'assistant',
          content: [
            ...(turn.reasoning
              ? [{ type: 'reasoning' as const, text: redact(turn.reasoning) }]
              : []),
            ...(turn.text ? [{ type: 'text' as const, text: redact(turn.text) }] : []),
            ...turn.toolCalls.map((c) => ({
              type: 'tool-call' as const,
              toolCallId: c.id,
              toolName: c.name,
              input: c.input,
            })),
          ],
        };
        return {
          turn: { ...turn, text: redact(turn.text) },
          steps: state.steps + 1,
          tokens: state.tokens + summaryTokens + totalTokens,
          messages: [...preparedMessages, assistant],
        };
      })
      .addNode('tools', async (state) => {
        const messages = [...state.messages];
        const loaded = new Set(state.loaded);
        const context: ToolContext = {
          skills: this.skills,
          wiki: {
            query: (query, limit) => this.wiki.query(query, limit),
            search: (input) => this.wiki.search(input),
            read: (input, signal) => this.wiki.read(input, signal),
          },
          executor: {
            execute: (input, caller, trace) => this.executor.execute(input, caller, trace),
          },
          audit: {
            beginExecution: this.store.beginExecution.bind(this.store),
            finishExecution: this.store.finishExecution.bind(this.store),
          },
          network: { allowPrivateAddresses: this.config.webAllowPrivateAddresses },
          diagnostics: this.diagnostics,
          run: { id: runId, signal, loadedSkills: loaded, failedScripts },
        };
        if (state.turn.toolCalls.length > 16)
          throw new AppError('budget', 'Too many tool calls in one model turn');
        for (const call of state.turn.toolCalls) {
          check();
          const startedAt = Date.now();
          const identity = { name: call.name, toolCallId: call.id };
          const details =
            call.input && typeof call.input === 'object'
              ? (call.input as Record<string, unknown>)
              : {};
          emit('tool.started', {
            ...identity,
            status: 'running',
            ...(call.name === 'skill' && typeof details.name === 'string'
              ? { skill: redact(details.name).slice(0, 256) }
              : typeof details.skill === 'string'
                ? { skill: redact(details.skill).slice(0, 256) }
                : {}),
            ...(typeof details.path === 'string'
              ? { path: redact(details.path).slice(0, 256) }
              : {}),
          });
          let output: unknown;
          let modelText: string | undefined;
          let status = 'completed';
          let terminalEmitted = false;
          const fail = (message: string) => {
            terminalEmitted = true;
            emit('tool.failed', {
              ...identity,
              status,
              message: redact(message),
              durationMs: Date.now() - startedAt,
            });
          };
          try {
            const result = await this.toolRegistry.execute(call.name, call.input, context);
            output = result.output;
            status = result.status;
            modelText = result.modelText;
          } catch (error) {
            if (error instanceof UncertainToolError) uncertain = true;
            if (status === 'completed')
              status = uncertain ? 'unknown' : signal.aborted ? 'cancelled' : 'failed';
            fail(errorText(error));
            if (uncertain || signal.aborted) throw error;
            output = {
              error: error instanceof AppError ? error.code : 'tool_error',
              message: errorText(error),
            };
          }
          output = JSON.parse(redact(JSON.stringify(output ?? null)));
          messages.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: call.id,
                toolName: call.name,
                output:
                  modelText !== undefined && status === 'completed'
                    ? { type: 'text', value: redact(modelText) }
                    : { type: 'json', value: output as never },
              },
            ],
          });
          if (!terminalEmitted) {
            if (status === 'completed')
              emit('tool.completed', { ...identity, status, durationMs: Date.now() - startedAt });
            else fail(`Script finished with status: ${status}`);
          }
        }
        return { messages, loaded: [...loaded] };
      })
      .addEdge(START, 'model')
      .addConditionalEdges('model', (state) => (state.turn.toolCalls.length ? 'tools' : END))
      .addEdge('tools', 'model')
      .compile({ checkpointer: new SQLiteSaver(this.store.db) });
    emit('session.status', { status: 'busy' });
    try {
      const history: ModelMessage[] = this.store
        .contextMessages(sessionId, this.config.requestLimitBytes * this.config.maxSteps)
        .map((message) =>
          message.role === 'assistant' && message.reasoning
            ? {
                role: 'assistant',
                content: [
                  { type: 'reasoning', text: redact(message.reasoning) },
                  { type: 'text', text: message.content },
                ],
              }
            : { role: message.role, content: message.content },
        );
      const system: ModelMessage = {
        role: 'system',
        content: redact(
          [
            this.config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
            toolGuidance(this.config.webAllowPrivateAddresses),
          ].join('\n\n'),
        ),
      };
      const result = await graph.invoke(
        {
          messages: [system, ...history],
          steps: 0,
          tokens: 0,
          loaded: [],
          turn: { text: '', toolCalls: [], usage: { totalTokens: 0 } },
        },
        {
          configurable: { thread_id: runId },
          recursionLimit: this.config.maxSteps * 2 + 2,
          signal,
        },
      );
      check();
      const reply = this.store.addMessage(
        sessionId,
        'assistant',
        result.turn.text,
        messageId,
        result.turn.reasoning ? redact(result.turn.reasoning) : undefined,
      );
      this.store.finishRun(runId, 'completed');
      this.diagnostics.write('agent', 'generation.completed', { sessionId, runId, messageId });
      const active = this.active.get(sessionId);
      if (active) active.completed = true;
      emit('message.completed', { message: reply });
      return reply;
    } catch (error) {
      const status = uncertain ? 'waiting_for_operator' : signal.aborted ? 'cancelled' : 'failed';
      this.store.finishRun(runId, status);
      const message = redact(
        uncertain
          ? `Script outcome is unknown. Manual reconciliation is required; no automatic replay.\n${errorText(error)}\nUse /review for diagnostic details. Logs: ${this.diagnostics.directory}`
          : signal.aborted
            ? 'Generation cancelled. This does not confirm physical equipment stopped.'
            : errorText(error),
      );
      this.diagnostics.write('agent', 'generation.failed', {
        sessionId,
        runId,
        status,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      });
      this.store.addMessage(sessionId, 'assistant', message, messageId);
      emit('session.error', { code: status, message });
      throw new AppError(status, message, signal.aborted ? 409 : 502);
    } finally {
      emit('session.status', { status: 'idle' });
    }
  }
}
