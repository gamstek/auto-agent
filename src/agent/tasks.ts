import type { Config } from '../config';
import type { Store } from '../storage';
import { AppError, requireTokenUsage, type Message, type ModelAdapter } from '../shared/types';
import { SESSION_TITLE_PROMPT } from './title-prompt';
import { waitFor } from '../shared/abort';
import type { Events } from './events';

export class SessionTitles {
  private tasks = new Map<string, { controller: AbortController; done: Promise<void> }>();
  constructor(
    private config: Config,
    private store: Store,
    private model: ModelAdapter,
    private events: Events,
    private redact: (text: string) => string,
  ) {}
  start(sessionId: string, reply: Message) {
    if (
      this.tasks.has(sessionId) ||
      this.tasks.size >= this.config.maxConcurrent ||
      !this.model.complete ||
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
        try {
          signal.throwIfAborted();
          const generated = await waitFor(
            this.model.complete!({
              messages: [
                { role: 'system', content: SESSION_TITLE_PROMPT },
                { role: 'user', content: this.store.firstUserContent(sessionId) },
                { role: 'assistant', content: reply.content.slice(0, 2000) },
              ],
              signal,
              maxOutputTokens: 128,
            }),
            signal,
          );
          signal.throwIfAborted();
          requireTokenUsage(generated.usage);
          if (generated.finishReason !== 'stop')
            throw new AppError('incomplete_title', 'Title response was incomplete');
          const title = [
            ...this.redact(generated.text)
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
        }
      })
      .finally(() => this.tasks.delete(sessionId));
    this.tasks.set(sessionId, { controller, done });
  }
  async close() {
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.done));
  }
}
