import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import type { ModelMessage } from 'ai';
import type { Config } from '../config';
import { Skills } from '../skill';
import { escapeXml, skillContent, skillGuidance } from '../skill/prompt';
import { ScriptExecutor } from '../execution';
import { Store } from '../storage';
import { SQLiteSaver } from '../storage/checkpointer';
import { BuiltinToolRegistry } from '../llm/tools';
import { fetchWeb } from '../llm/tools/web-fetch';
import { Wiki } from '../wiki';
import {
  AppError,
  errorText,
  type ModelAdapter,
  type ModelTurn,
  type Message,
} from '../shared/types';
import { Events } from './events';
import { DEFAULT_SYSTEM_PROMPT, systemInstructions } from './prompt';
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
        if (state.steps >= this.config.maxSteps || state.tokens >= this.config.maxTokens)
          throw new AppError('budget', 'Agent step or token budget exhausted');
        const modelSignal = AbortSignal.any([
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
        try {
          let guidance = skillGuidance(this.skills.list());
          for (const secret of [this.config.apiKey, this.config.token])
            if (secret) guidance = guidance.split(escapeXml(secret)).join('[redacted]');
          const modelMessages: ModelMessage[] = [
            ...state.messages.filter((message) => message.role === 'system'),
            { role: 'system', content: redact(guidance) },
            ...state.messages.filter((message) => message.role !== 'system'),
          ];
          rawTurn = await this.model.generate(modelMessages, modelSignal, (text) => {
            pendingDelta = redact(pendingDelta + text);
            flush();
          });
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
        emit('model.completed', {
          step: state.steps + 1,
          totalTokens: turn.totalTokens,
          durationMs: Date.now() - modelStarted,
        });
        check();
        if (state.tokens + turn.totalTokens > this.config.maxTokens)
          throw new AppError('budget', 'Agent token budget exhausted');
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
          tokens: state.tokens + turn.totalTokens,
          messages: [...state.messages, assistant],
        };
      })
      .addNode('tools', async (state) => {
        const messages = [...state.messages];
        const loaded = new Set(state.loaded);
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
            output = await this.toolRegistry.execute(call.name, call.input, loaded, {
              skill: async ({ name }) => {
                const content = await this.skills.load(name);
                const skill = this.skills.list().find((entry) => entry.name === name)!;
                const body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
                const result = {
                  name: skill.name,
                  directory: skill.directory,
                  output: skillContent(
                    skill.name,
                    skill.directory,
                    body,
                    await this.skills.files(skill.name),
                  ),
                };
                loaded.add(skill.name);
                return result;
              },
              query_knowledge: async ({ query, limit }) => this.wiki.query(query, limit),
              read_skill_resource: async ({ skill, path }) => this.skills.read(skill, path),
              web_fetch: async ({ url }) => fetchWeb(url, signal),
              execute_skill_script: async (input) => {
                const entry = await this.skills.resolveScript(input.skill, input.path);
                const signature = JSON.stringify([input.skill, entry.path, input.args]);
                if (failedScripts.has(signature))
                  throw new AppError(
                    'replay_blocked',
                    'A failed script cannot be automatically retried in this generation',
                  );
                const executionId = this.store.beginExecution(runId, input.skill, entry.path);
                try {
                  const result = await this.executor.execute(input, signal);
                  this.store.finishExecution(executionId, result);
                  output = result;
                  status = result.status;
                  if (result.status !== 'completed') failedScripts.add(signature);
                  if (result.status === 'unknown') {
                    uncertain = true;
                    throw new AppError(
                      'uncertain_execution',
                      'Script termination is unconfirmed; manual reconciliation required',
                    );
                  }
                  return result;
                } catch (error) {
                  if (!output) {
                    uncertain = !(error instanceof AppError);
                    failedScripts.add(signature);
                    this.store.finishExecution(executionId, {
                      status: uncertain ? 'unknown' : 'failed',
                      exitCode: null,
                      stdout: '',
                      stderr: '',
                    });
                  }
                  throw error;
                }
              },
            });
          } catch (error) {
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
                  call.name === 'skill' && status === 'completed'
                    ? { type: 'text', value: (output as { output: string }).output }
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
        .contextMessages(sessionId, this.config.maxTokens * 3)
        .map((message) => ({ role: message.role, content: message.content }));
      const system: ModelMessage = {
        role: 'system',
        content: redact(systemInstructions()),
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
          turn: { text: '', toolCalls: [], totalTokens: 0 },
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
