import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import type { ModelMessage } from 'ai';
import { AppError, errorText, requireTokenUsage, type ModelTurn } from '../shared/types';
import { redactedStream } from '../shared/redaction';
import { waitFor } from '../shared/abort';
import { ModelRequestError } from '../llm/errors';
import { ToolExecutor } from '../tool/executor';
import { UncertainToolError } from '../tool/context';
import { fitModelContext } from './context';
import type { RunContext, RunnerPorts, RunOutput } from './contracts';

const State = Annotation.Root({
  messages: Annotation<ModelMessage[]>(),
  turn: Annotation<ModelTurn>(),
  steps: Annotation<number>(),
  tokens: Annotation<number>(),
});

/** One generation. Application services own admission, resources and durable terminal state. */
export class AgentRunner {
  constructor(private ports: RunnerPorts) {}

  async run(context: RunContext): Promise<RunOutput> {
    const reasoningParts: string[] = [];
    const { signal, runId } = context;
    const { limits, model, redact } = this.ports;
    const emit = (type: string, properties: Record<string, unknown> = {}) =>
      this.ports.emit(context, type, properties);
    const check = () => {
      if (signal.aborted) throw new AppError('cancelled', 'Generation cancelled');
    };
    const tools = await this.ports.tools(context);
    check();
    const executor = new ToolExecutor(
      tools,
      signal,
      redact,
      emit,
      (evidence) => this.ports.evidence(context, evidence),
      (call, result) => this.ports.transcript?.toolCall(context, call, result),
    );
    let historyTokens = 0;
    const history = await this.ports.history(context, tools.contextTokenEstimate(), (details) => {
      historyTokens += Number(details.totalTokens);
      emit('context.compressed', { ...details, runTokens: historyTokens });
    });
    const graph = new StateGraph(State)
      .addNode('model', async (state) => {
        check();
        if (state.steps >= limits.maxSteps)
          throw new AppError(
            'budget',
            `Agent step budget exhausted (${state.steps}/${limits.maxSteps}). Split the workflow or increase maxSteps; no additional tools were executed.`,
          );
        let modelSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.modelTimeoutMs)]);
        const started = Date.now();
        const step = state.steps + 1;
        emit('model.started', { step });
        let streamedReasoning = '';
        const channel = (type: string) =>
          redactedStream({
            secrets: this.ports.secrets(),
            redact,
            emit: (delta) => {
              if (type === 'message.reasoning.delta') streamedReasoning += delta;
              emit(type, { delta, step });
            },
            aborted: () => modelSignal.aborted,
          });
        const text = channel('message.part.delta');
        const reasoning = channel('message.reasoning.delta');
        let turn: ModelTurn;
        let prepared = state.messages;
        let summaryTokens = 0;
        let summaries = 0;
        try {
          const instructions = await this.ports.instructions({ ...context, signal: modelSignal });
          const fitted = await fitModelContext(
            [
              ...state.messages.filter((message) => message.role === 'system'),
              ...instructions,
              ...state.messages.filter((message) => message.role !== 'system'),
            ],
            limits.maxInputTokens,
            tools.contextTokenEstimate(),
            {
              signal,
              retentionFor: (name) => tools.retentionFor(name),
              summarize: model.summarize
                ? async (messages, caller) => {
                    const summarySignal = AbortSignal.any([
                      caller,
                      AbortSignal.timeout(limits.modelTimeoutMs),
                    ]);
                    const summaryNode = `summary:${step}:${++summaries}`;
                    const safeMessages = JSON.parse(redact(JSON.stringify(messages)));
                    this.ports.trace?.request(context, summaryNode, 'summary', {
                      messages: safeMessages,
                      tools: [],
                      maxOutputTokens: limits.maxOutputTokens,
                    });
                    try {
                      const summary = await waitFor(
                        model.summarize!(safeMessages, summarySignal),
                        summarySignal,
                      );
                      summarySignal.throwIfAborted();
                      this.ports.trace?.finish(context, summaryNode, 'completed');
                      return { ...summary, text: redact(summary.text) };
                    } catch (error) {
                      this.ports.trace?.finish(
                        context,
                        summaryNode,
                        summarySignal.aborted ? 'cancelled' : 'failed',
                      );
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
                  inputTokenLimit: limits.maxInputTokens,
                  maxOutputTokens: limits.maxOutputTokens,
                  runTokens: state.tokens + summaryTokens,
                });
              },
            },
          );
          prepared = [
            ...state.messages.filter((message) => message.role === 'system'),
            ...fitted.messages.filter((message) => message.role !== 'system'),
          ];
          emit('context.prepared', {
            estimatedInputTokens: fitted.estimatedTokens,
            maxInputTokens: limits.maxInputTokens,
          });
          modelSignal = AbortSignal.any([signal, AbortSignal.timeout(limits.modelTimeoutMs)]);
          this.ports.trace?.request(context, `model:${step}`, 'model', {
            messages: fitted.messages,
            tools: tools.definitions?.() ?? Object.keys(tools.modelTools()),
            maxOutputTokens: limits.maxOutputTokens,
          });
          const raw = await waitFor(
            model.generate({
              messages: fitted.messages,
              tools: tools.modelTools(),
              signal: modelSignal,
              onText: text.write,
              onReasoning: reasoning.write,
            }),
            modelSignal,
          );
          modelSignal.throwIfAborted();
          requireTokenUsage(raw.usage);
          if (
            raw.finishReason &&
            ['length', 'content-filter', 'error', 'other'].includes(raw.finishReason)
          )
            throw new AppError(
              'model_incomplete',
              `Model response ended with ${raw.finishReason}; dependent tools were not executed.`,
              502,
            );
          turn = JSON.parse(redact(JSON.stringify(raw)));
        } catch (error) {
          const failure =
            !signal.aborted &&
            modelSignal.aborted &&
            (!(error instanceof AppError) || error.code === 'cancelled')
              ? new AppError(
                  'model_timeout',
                  `Model request timed out after ${limits.modelTimeoutMs} ms. No additional tools were executed; verify the last recorded operation state before continuing.`,
                  504,
                )
              : error;
          if (failure instanceof ModelRequestError)
            emit('model.diagnostic', { step, code: failure.code, ...failure.diagnostic });
          emit('model.failed', {
            step,
            status: signal.aborted
              ? 'cancelled'
              : failure instanceof AppError && failure.code === 'model_timeout'
                ? 'timeout'
                : 'failed',
            code: failure instanceof AppError ? failure.code : 'model_error',
            message: errorText(failure),
            durationMs: Date.now() - started,
          });
          throw failure;
        }
        reasoning.flush(true);
        if (!turn.reasoning && streamedReasoning) turn.reasoning = streamedReasoning;
        if (turn.reasoning) reasoningParts.push(turn.reasoning);
        text.flush(true);
        if (turn.reasoning && !reasoning.hasEmitted())
          emit('message.reasoning.delta', { delta: turn.reasoning, step });
        if (turn.text && !text.hasEmitted()) emit('message.part.delta', { delta: turn.text, step });
        this.ports.transcript?.modelOutput(context, step, turn.text, turn.reasoning);
        const totalTokens = requireTokenUsage(turn.usage);
        emit('model.completed', {
          step,
          usage: turn.usage,
          totalTokens,
          inputTokens: turn.usage.inputTokens,
          outputTokens: turn.usage.outputTokens,
          runTokens: state.tokens + summaryTokens + totalTokens,
          durationMs: Date.now() - started,
        });
        check();
        const assistant: ModelMessage = {
          role: 'assistant',
          content: [
            ...(turn.reasoning ? [{ type: 'reasoning' as const, text: turn.reasoning }] : []),
            ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
            ...turn.toolCalls.map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.input,
            })),
          ],
        };
        return {
          turn,
          steps: step,
          tokens: state.tokens + summaryTokens + totalTokens,
          messages: [...prepared, assistant],
        };
      })
      .addNode('tools', async (state) => {
        if (state.turn.toolCalls.length > limits.maxToolCalls)
          throw new AppError('budget', 'Too many tool calls in one model turn');
        const messages = [...state.messages];
        let blocked = false;
        for (const call of state.turn.toolCalls) {
          check();
          if (blocked) {
            messages.push({
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: call.id,
                  toolName: call.name,
                  output: {
                    type: 'json',
                    value: {
                      error: 'dependency_blocked',
                      message:
                        'Not executed: an earlier tool in this turn failed. Inspect its result and plan the next step in a new model turn.',
                    },
                  },
                },
              ],
            });
            emit('tool.skipped', {
              name: call.name,
              toolCallId: call.id,
              status: 'dependency_blocked',
            });
            this.ports.transcript?.toolCall(context, call, {
              status: 'failed',
              effect: 'none',
              output: {
                error: 'dependency_blocked',
                message: 'Not executed because an earlier tool in this turn failed.',
              },
            });
            continue;
          }
          const result = await executor.execute(call);
          if (result.effect === 'unknown')
            throw new UncertainToolError('Tool outcome is unknown; manual reconciliation required');
          check();
          blocked = result.status !== 'completed';
          messages.push({
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: call.id,
                toolName: call.name,
                output:
                  result.modelText !== undefined && !blocked
                    ? { type: 'text', value: redact(result.modelText) }
                    : {
                        type: 'json',
                        value: JSON.parse(redact(JSON.stringify(result.output ?? null))),
                      },
              },
            ],
          });
        }
        return { messages };
      })
      .addEdge(START, 'model')
      .addConditionalEdges('model', (state) => (state.turn.toolCalls.length ? 'tools' : END), {
        tools: 'tools',
        [END]: END,
      })
      .addEdge('tools', 'model')
      .compile({ checkpointer: this.ports.checkpoint });
    if (this.ports.trace) {
      const topology = await graph.getGraphAsync();
      this.ports.trace.graph(context, {
        nodes: Object.keys(topology.nodes),
        edges: topology.edges.map((edge) => ({
          source: String(edge.source),
          target: String(edge.target),
          conditional: !!edge.conditional,
        })),
        mermaid: topology.drawMermaid(),
      });
    }
    const result = await graph.invoke(
      {
        messages: [{ role: 'system', content: redact(this.ports.role) }, ...history],
        steps: 0,
        tokens: historyTokens,
        turn: { text: '', toolCalls: [], usage: { totalTokens: 0 } },
      },
      { configurable: { thread_id: runId }, recursionLimit: limits.maxSteps * 2 + 2, signal },
    );
    check();
    return { text: result.turn.text, reasoning: reasoningParts.join('\n\n') || undefined };
  }
}
