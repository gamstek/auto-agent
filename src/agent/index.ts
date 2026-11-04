import type { Config } from '../config';
import { Skills } from '../skill';
import { escapeXml, skillGuidance } from '../skill/prompt';
import { ScriptExecutor } from '../execution';
import { Store } from '../storage';
import { SQLiteSaver } from '../storage/checkpointer';
import { BuiltinToolRegistry, UncertainToolError, type ToolContext } from '../tool';
import { toolGuidance } from '../tool/prompt';
import { AppError, errorText, type ModelAdapter, type Message } from '../shared/types';
import { Diagnostics } from '../shared/diagnostics';
import { createRedactor } from '../shared/redaction';
import { McpService } from '../mcp/service';
import { mcpEnvironmentSecrets } from '../mcp/config';
import { Events } from './events';
import { DEFAULT_SYSTEM_PROMPT } from './prompt';
import { builtinInstructions } from './builtins';
import { loadSessionHistory } from './history';
import { AgentRunner } from './runner';
import type { RunContext } from './contracts';
import { SessionTitles } from './tasks';
import { reviewReport, reviewText } from './review';
import type { WikiLibrary } from '@auto-agent/wiki-core';

/** Application facade: admission, resource ownership, events and durable run finalization. */
export class AgentService {
  readonly events = new Events();
  readonly mcp: McpService;
  private active = new Map<
    string,
    { controller: AbortController; done: Promise<Message>; completed: boolean }
  >();
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private titles: SessionTitles;
  private runner: AgentRunner;
  private redact: (text: string) => string;
  private reasoning = new Map<string, string>();

  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly skills: Skills,
    executor: ScriptExecutor,
    model: ModelAdapter,
    readonly diagnostics = new Diagnostics(config.dataDir, [
      config.apiKey ?? '',
      config.token,
      ...mcpEnvironmentSecrets(config.mcpServers),
    ]),
    readonly library?: WikiLibrary,
  ) {
    this.mcp = new McpService(config, store);
    const secrets = () => [config.apiKey ?? '', config.token, ...this.mcp.secrets()];
    this.redact = createRedactor(secrets);
    this.titles = new SessionTitles(config, store, model, this.events, this.redact);
    this.runner = new AgentRunner({
      model: {
        generate: (request) =>
          model.generate(
            request.messages,
            request.signal,
            request.onText,
            request.onReasoning,
            request.tools,
          ),
        summarize: model.summarize?.bind(model),
      },
      limits: {
        get maxSteps() {
          return config.maxSteps;
        },
        get maxInputTokens() {
          return config.maxInputTokens;
        },
        get maxOutputTokens() {
          return config.maxOutputTokens;
        },
        get modelTimeoutMs() {
          return config.modelTimeoutMs;
        },
        maxToolCalls: 16,
      },
      checkpoint: new SQLiteSaver(store.db),
      transcript: {
        modelOutput: (context, step, text, reasoning) =>
          this.inspect(() =>
            store.transcripts.recordModel(
              context.runId,
              step,
              this.redact(text),
              reasoning ? this.redact(reasoning) : undefined,
            ),
          ),
        toolCall: (context, call, result) =>
          this.inspect(() =>
            store.transcripts.recordTool(
              context.runId,
              this.inspectionData(call) as typeof call,
              result ? (this.inspectionData(result) as typeof result) : undefined,
            ),
          ),
      },
      trace: {
        graph: (context, graph) => this.inspect(() => store.traces.graph(context.runId, graph)),
        request: (context, nodeId, kind, request) =>
          this.inspect(() =>
            store.traces.request(
              context.runId,
              nodeId,
              kind,
              this.inspectionData({ model: config.model, payload: request }),
            ),
          ),
        finish: (context, nodeId, status) =>
          this.inspect(() => store.traces.finish(context.runId, nodeId, status)),
      },
      get role() {
        return [
          config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
          toolGuidance(config.webAllowPrivateAddresses),
        ].join('\n\n');
      },
      redact: this.redact,
      secrets,
      emit: (context, type, properties) => this.emit(context, type, properties),
      evidence: (context, evidence) => store.recordToolEvidence(context.runId, evidence),
      instructions: async ({ signal }) => {
        let builtins = await builtinInstructions({ signal });
        let guidance = skillGuidance(skills.list());
        for (const secret of secrets()) {
          if (!secret) continue;
          builtins = builtins.split(escapeXml(secret)).join('[redacted]');
          guidance = guidance.split(escapeXml(secret)).join('[redacted]');
        }
        return [
          { role: 'system', content: this.redact(builtins) },
          { role: 'system', content: this.redact(guidance) },
        ];
      },
      history: (context, toolTokens, onSummary) =>
        loadSessionHistory({
          store,
          sessionId: context.sessionId,
          maxInputTokens: config.maxInputTokens,
          timeoutMs: config.modelTimeoutMs,
          signal: context.signal,
          toolTokens,
          model: {
            summarize: model.summarize
              ? async (messages, signal) => {
                  const nodeId = `history-summary:${crypto.randomUUID()}`;
                  this.inspect(() =>
                    store.traces.request(
                      context.runId,
                      nodeId,
                      'summary',
                      this.inspectionData({
                        model: config.model,
                        payload: { messages, tools: [], maxOutputTokens: config.maxOutputTokens },
                      }),
                    ),
                  );
                  try {
                    const result = await model.summarize!(messages, signal);
                    signal.throwIfAborted();
                    this.inspect(() => store.traces.finish(context.runId, nodeId, 'completed'));
                    return result;
                  } catch (error) {
                    this.inspect(() =>
                      store.traces.finish(
                        context.runId,
                        nodeId,
                        signal.aborted ? 'cancelled' : 'failed',
                      ),
                    );
                    throw error;
                  }
                }
              : undefined,
          },
          redact: this.redact,
          onSummary,
        }),
      tools: async ({ runId, signal }) => {
        const registry = new BuiltinToolRegistry(
          await this.mcp.catalog(signal),
          (tool, input, context) => this.mcp.invoke(tool, input, context),
        );
        const context: ToolContext = {
          skills,
          library,
          executor: { execute: (input, caller, trace) => executor.execute(input, caller, trace) },
          audit: {
            beginExecution: store.beginExecution.bind(store),
            finishExecution: store.finishExecution.bind(store),
          },
          network: { allowPrivateAddresses: config.webAllowPrivateAddresses },
          diagnostics,
          run: { id: runId, signal, loadedSkills: new Set(), failedScripts: new Set() },
        };
        return {
          definitions: () => registry.definitions(),
          modelTools: () => registry.modelTools(),
          contextTokenEstimate: () => registry.contextTokenEstimate(),
          retentionFor: (name) => registry.retentionFor(name),
          eventMetadata: (name, input) => registry.eventMetadata(name, input),
          execute: (name, input) => registry.execute(name, input, context),
        };
      },
    });
  }

  private ensureOpen() {
    if (this.closing) throw new AppError('shutdown', 'Agent is shutting down', 503);
  }
  refreshLibrary(signal: AbortSignal) {
    this.ensureOpen();
    if (!this.library || !this.config.wiki)
      throw new AppError('wiki_unavailable', 'Unified Wiki is not configured');
    return this.library.build(this.config.wiki.sources, signal);
  }
  runtimeStatus() {
    return {
      closing: this.closing,
      runningSessions: [...this.active.keys()],
      updatingWiki: !!this.library?.building,
    };
  }
  sessionState(sessionId: string) {
    this.store.getSession(sessionId);
    return {
      running: this.active.has(sessionId),
      run: this.store.latestRun(sessionId),
      ...this.review(sessionId),
    };
  }
  review(sessionId: string) {
    return reviewReport(this.store, this.diagnostics, sessionId, this.redact);
  }
  reviewMessage(sessionId: string): Message {
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: 'assistant',
      content: reviewText(this.store, this.diagnostics, sessionId, this.redact),
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
      `Operator review recorded for ${runId}. The interrupted run remains failed and its executions retain their original unknown status. This does not confirm external effects were undone.\nReview: ${safeNote}`,
    );
  }
  submit(sessionId: string, content: string): Promise<Message> {
    this.store.getSession(sessionId);
    this.ensureOpen();
    if (!content.trim() || Buffer.byteLength(content) > this.config.requestLimitBytes)
      throw new AppError('invalid_message', 'Message is empty or too large');
    if (this.active.has(sessionId))
      throw new AppError('session_busy', 'Session already has an active generation', 409);
    if (this.store.pendingReview(sessionId)) {
      const reply = this.store.recordReviewReply(
        sessionId,
        this.redact(content),
        reviewText(this.store, this.diagnostics, sessionId, this.redact),
      );
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
    const runId = this.store.beginTurn(sessionId, this.redact(content));
    const controller = new AbortController();
    const done = this.run({ sessionId, messageId, runId, signal: controller.signal })
      .finally(() => this.active.delete(sessionId))
      .then((reply) => {
        if (!this.closing) this.titles.start(sessionId, reply);
        return reply;
      });
    this.active.set(sessionId, { controller, done, completed: false });
    return done;
  }
  async abort(sessionId: string): Promise<boolean> {
    this.store.getSession(sessionId);
    const active = this.active.get(sessionId);
    if (!active || active.completed) return false;
    active.controller.abort();
    await active.done.catch(() => {});
    return true;
  }
  shutdown(): Promise<void> {
    return (this.shutdownPromise ??= this.close());
  }
  private async close() {
    this.closing = true;
    this.diagnostics.write('agent', 'service.stopping');
    for (const active of this.active.values()) active.controller.abort();
    await Promise.allSettled([
      this.mcp.close(),
      this.titles.close(),
      this.library?.close(),
      ...[...this.active.values()].map((entry) => entry.done),
    ]);
    this.events.close();
    this.diagnostics.write('agent', 'service.stopped');
  }
  private emit(context: RunContext, type: string, properties: Record<string, unknown> = {}) {
    const { sessionId, messageId, runId } = context;
    const safe = JSON.parse(this.redact(JSON.stringify(properties)));
    if (type === 'message.reasoning.delta') {
      this.reasoning.set(runId, (this.reasoning.get(runId) ?? '') + String(safe.delta ?? ''));
    }
    this.inspect(() => this.store.traces.event(runId, type, safe));
    this.inspect(() => this.store.transcripts.recordEvent(runId, type, safe));
    if (!['message.part.delta', 'message.reasoning.delta', 'message.completed'].includes(type))
      this.diagnostics.write('agent', type, { ...safe, sessionId, messageId, runId });
    // Detailed provider diagnostics remain file-only.
    if (type !== 'model.diagnostic')
      this.events.publish({ type, sessionId, messageId, properties: safe });
  }
  private inspect(operation: () => void) {
    try {
      operation();
    } catch {
      this.diagnostics.write('agent', 'trace.unavailable', { code: 'trace_storage' });
    }
  }
  private inspectionData(value: unknown): unknown {
    return JSON.parse(
      JSON.stringify(value, (_key, item) => (typeof item === 'string' ? this.redact(item) : item)),
    );
  }
  private async run(context: RunContext): Promise<Message> {
    const { sessionId, runId, messageId, signal } = context;
    this.emit(context, 'session.status', { status: 'busy' });
    try {
      const output = await this.runner.run(context);
      const reply = this.store.completeRun(runId, sessionId, messageId, output);
      this.diagnostics.write('agent', 'generation.completed', { sessionId, runId, messageId });
      const active = this.active.get(sessionId);
      if (active) active.completed = true;
      this.emit(context, 'message.completed', { message: reply });
      return reply;
    } catch (error) {
      const uncertain = error instanceof UncertainToolError;
      const status = uncertain ? 'waiting_for_operator' : signal.aborted ? 'cancelled' : 'failed';
      const message = this.redact(
        uncertain
          ? `Tool outcome is unknown. Manual reconciliation is required; no automatic replay.\n${errorText(error)}\nUse /review for diagnostic details. Logs: ${this.diagnostics.directory}`
          : signal.aborted
            ? 'Generation cancelled. This does not confirm external effects were undone.'
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
      try {
        this.store.failRun(runId, sessionId, messageId, status, message, this.reasoning.get(runId));
      } catch (storageError) {
        // Do not mask the original outcome or admit more work after durable finalization fails.
        this.closing = true;
        this.diagnostics.write('agent', 'generation.persistence_failed', {
          sessionId,
          runId,
          status,
          message: errorText(storageError),
        });
      }
      this.emit(context, 'session.error', { code: status, message });
      throw new AppError(status, message, signal.aborted ? 409 : 502);
    } finally {
      this.reasoning.delete(runId);
      this.emit(context, 'session.status', { status: 'idle' });
    }
  }
}
