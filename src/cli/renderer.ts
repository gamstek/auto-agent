import { safeTerminalText, TerminalMarkdown, TerminalText } from './markdown';
import type { Writable } from 'node:stream';
import type { AgentEvent, Message } from '../shared/types';
import { ConsoleOutput } from '../shared/console';
const colors = { user: 36, assistant: 32, system: 90, tool: 33, error: 31 };
export class ReplRenderer {
  private textOpen = false;
  private markdown?: TerminalMarkdown;
  private reasoningOpen = false;
  private reasoningText?: TerminalText;
  private readonly console: ConsoleOutput;
  constructor(
    private output: Writable,
    private error: Writable,
    private color: boolean,
    private diagnosticColor = color,
  ) {
    this.console = new ConsoleOutput(output, error, diagnosticColor);
  }
  private style(text: string, role: keyof typeof colors): string {
    const safe = safeTerminalText(text);
    return this.color ? `\x1b[${colors[role]}m${safe}\x1b[0m` : safe;
  }
  private closeText(): void {
    if (this.reasoningOpen) {
      this.reasoningText?.finish();
      this.reasoningText = undefined;
      this.error.write('\n');
      this.reasoningOpen = false;
    }
    if (this.textOpen) {
      this.markdown?.finish();
      this.markdown = undefined;
      this.output.write('\n');
      this.textOpen = false;
    }
  }
  line(text: string, role: keyof typeof colors = 'system'): void {
    this.closeText();
    if (role === 'user' || role === 'assistant') this.output.write(this.style(text, role) + '\n');
    else this.console.diagnostic(text, role === 'error' ? 'error' : 'info');
  }
  history(message: Message): void {
    if (message.role === 'user') {
      this.line(`user: ${message.content}`, 'user');
      return;
    }
    this.closeText();
    this.output.write(this.style('assistant: ', 'assistant'));
    const markdown = new TerminalMarkdown((text) => this.output.write(text), this.color);
    markdown.append(message.content);
    markdown.finish();
    this.output.write('\n');
  }
  prompt(): string {
    return this.style('you > ', 'user');
  }
  event(event: AgentEvent): void {
    const p = event.properties;
    switch (event.type) {
      case 'session.status':
        if (p.status === 'busy') this.line('[agent] working…');
        break;
      case 'context.prepared':
        this.line(`[context] estimated input ${p.estimatedInputTokens}/${p.maxInputTokens} tokens`);
        break;
      case 'context.compressed':
        this.line(
          `[context] summarized ${p.removedMessages} earlier messages · ${p.estimatedInputTokens}/${p.inputTokenLimit} estimated input tokens · summary ${p.totalTokens ?? (p.usage as { totalTokens?: number } | undefined)?.totalTokens ?? 'unknown'} tokens`,
        );
        break;
      case 'model.started':
        this.line(`[model] generating · step ${p.step}`);
        break;
      case 'model.failed':
        this.line(`[model] ${p.status} · ${p.durationMs} ms`, 'error');
        break;
      case 'model.completed':
        this.closeText();
        this.line(
          `[model] step ${p.step} · ${p.totalTokens} tokens · input ${p.inputTokens ?? 'unknown'} / output ${p.outputTokens ?? 'unknown'}${typeof p.runTokens === 'number' ? ` · run ${p.runTokens}` : ''} · ${p.durationMs} ms`,
        );
        break;
      case 'message.part.delta':
        if (!this.textOpen) {
          this.closeText();
          this.output.write(this.style('assistant > ', 'assistant'));
          this.textOpen = true;
          this.markdown = new TerminalMarkdown((text) => this.output.write(text), this.color);
        }
        this.markdown?.append(String(p.delta));
        break;
      case 'message.reasoning.delta':
        if (!this.reasoningOpen) {
          this.closeText();
          this.error.write(this.diagnosticColor ? '\x1b[90mthink > \x1b[0m' : 'think > ');
          this.reasoningOpen = true;
          this.reasoningText = new TerminalText((text) => this.error.write(text));
        }
        this.reasoningText?.append(String(p.delta));
        break;
      case 'tool.started':
        this.line(
          `[tool] ${p.name} · running${p.skill ? ' · ' + p.skill : ''}${p.path ? ' · ' + p.path : ''}`,
          'tool',
        );
        break;
      case 'tool.completed':
        this.line(`[tool] ${p.name} · ${p.status} · ${p.durationMs} ms`, 'tool');
        break;
      case 'tool.failed':
        this.line(`[tool] ${p.name} · ${p.status} · ${p.message ?? 'failed'}`, 'error');
        break;
      case 'session.title.started':
        this.line('[session] generating title…');
        break;
      case 'session.updated':
        this.line(`[session] ${(p.session as { title: string }).title}`);
        break;
      case 'session.title.failed':
        this.line(`[session] ${p.message}`);
        break;
      case 'message.completed':
        this.closeText();
        this.line('[agent] completed');
        break;
    }
  }
  reply(message: Message, streamed: boolean): void {
    if (!streamed && message.content) this.history(message);
    this.closeText();
  }
  failure(text: string): void {
    this.closeText();
    this.console.error(text);
  }
}
