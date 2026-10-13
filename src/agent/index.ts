import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import type { ModelMessage } from 'ai';
import type { Config } from '../config';
import { Skills } from '../skill';
import { escapeXml, skillGuidance } from '../skill/prompt';
import { ScriptExecutor } from '../execution';
import { Store } from '../storage';
import { SQLiteSaver } from '../storage/checkpointer';
import { BuiltinToolRegistry, UncertainToolError, type ToolContext } from '../tool';
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
import { DEFAULT_SYSTEM_PROMPT, systemInstructions } from './prompt';
import { builtinInstructions } from './builtins';
import { fitModelContext } from './context';
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
    return new Wiki(this.config);
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
  ) {}
  submit(sessionId: string, content: string): Promise<Message> {
    this.store.getSession(sessionId);
    if (this.closing) throw new AppError('shutdown', 'Agent is shutting down', 503);
    if (!content.trim() || Buffer.byteLength(content) > this.config.requestLimitBytes)
      throw new AppError('invalid_message', 'Message is empty or too large');
    if (this.active.has(sessionId))
      throw new AppError('session_busy', 'Session already has an active generation', 409);
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
    this.closing = true;
    this.wikiUpdate?.controller.abort();
    const wikiDone = this.wikiUpdate?.done;
    for (const entry of [...this.active.values(), ...this.titles.values()])
      entry.controller.abort();
    await Promise.allSettled([
      ...[...this.active.values(), ...this.titles.values()].map((v) => v.done),
      ...(wikiDone ? [wikiDone] : []),
    ]);
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
    const emit = (type: string, properties: Record<string, unknown> = {}) =>
      this.events.publish({ type, sessionId, messageId, properties });
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
        let pendingDelta = '';
        let emittedText = false;
        const secrets = [this.config.apiKey, this.config.token].filter((value): value is string =>
          Boolean(value),
        );
        const flush = (final = false) => {
          let retain = 0;
          if (!final)
            for (const secret of secrets)
              for (let size = 1; size < secret.length; size++) {
                if (pendingDelta.endsWith(secret.slice(0, size))) retain = Math.max(retain, size);
              }
          const safe = pendingDelta.slice(0, pendingDelta.length - retain);
          pendingDelta = retain ? pendingDelta.slice(-retain) : '';
          if (safe) {
            emittedText = true;
            emit('message.part.delta', { delta: safe, step: state.steps + 1 });
          }
        };
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
          rawTurn = await this.model.generate(context.messages, modelSignal, (text) => {
            pendingDelta = redact(pendingDelta + text);
            flush();
          });
          requireTokenUsage(rawTurn.usage);
        } catch (error) {
          emit('model.failed', {
            step: state.steps + 1,
            status: signal.aborted ? 'cancelled' : 'failed',
            message: errorText(error),
            durationMs: Date.now() - modelStarted,
          });
          throw error;
        }
        flush(true);
        const turn: ModelTurn = JSON.parse(redact(JSON.stringify(rawTurn)));
        if (turn.text && !emittedText)
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
          wiki: { query: (query, limit) => this.wiki.query(query, limit) },
          executor: { execute: (input, caller) => this.executor.execute(input, caller) },
          audit: {
            beginExecution: this.store.beginExecution.bind(this.store),
            finishExecution: this.store.finishExecution.bind(this.store),
          },
          network: { allowPrivateAddresses: this.config.webAllowPrivateAddresses },
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
        .map((message) => ({ role: message.role, content: message.content }));
      const system: ModelMessage = {
        role: 'system',
        content: redact(systemInstructions(undefined, this.config.webAllowPrivateAddresses)),
      };
      const customSystem: ModelMessage[] =
        this.config.systemPrompt?.trim() && this.config.systemPrompt !== DEFAULT_SYSTEM_PROMPT
          ? [{ role: 'system', content: redact(this.config.systemPrompt) }]
          : [];
      const result = await graph.invoke(
        {
          messages: [system, ...customSystem, ...history],
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
      const reply = this.store.addMessage(sessionId, 'assistant', result.turn.text, messageId);
      this.store.finishRun(runId, 'completed');
      const active = this.active.get(sessionId);
      if (active) active.completed = true;
      emit('message.completed', { message: reply });
      return reply;
    } catch (error) {
      const status = uncertain ? 'waiting_for_operator' : signal.aborted ? 'cancelled' : 'failed';
      this.store.finishRun(runId, status);
      const message = uncertain
        ? 'Script outcome is unknown. Manual reconciliation is required; no automatic replay.'
        : signal.aborted
          ? 'Generation cancelled. This does not confirm physical equipment stopped.'
          : errorText(error);
      this.store.addMessage(sessionId, 'assistant', message, messageId);
      emit('session.error', { code: status, message });
      throw new AppError(status, message, signal.aborted ? 409 : 502);
    } finally {
      emit('session.status', { status: 'idle' });
    }
  }
}
