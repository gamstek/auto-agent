import { AppError, type AgentEvent } from '../shared/types';
export class Events {
  private streams = 0;
  private listeners = new Set<(event: AgentEvent) => void>();
  private closers = new Set<() => void>();
  private closed = false;
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stop of [...this.closers]) stop();
    this.listeners.clear();
  }
  publish(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {}
    }
  }
  subscribe(listener: (event: AgentEvent) => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  stream(signal: AbortSignal, maxClients = 32): ReadableStream<Uint8Array> {
    if (this.closed) throw new AppError('shutdown', 'Event service is closed', 503);
    if (this.streams >= maxClients)
      throw new AppError('event_capacity', 'Too many event subscribers', 429);
    this.streams++;
    const encoder = new TextEncoder();
    let cleanup = () => {};
    return new ReadableStream(
      {
        start: (controller) => {
          let closed = false;
          let unsubscribe = () => {};
          const stop = () => {
            if (closed) return;
            closed = true;
            this.streams--;
            unsubscribe();
            this.closers.delete(stop);
            clearInterval(timer);
            signal.removeEventListener('abort', stop);
            try {
              controller.close();
            } catch {}
          };
          const send = (data: string) => {
            if (closed) return;
            if ((controller.desiredSize ?? 0) <= 0) {
              stop();
              return;
            }
            controller.enqueue(encoder.encode(data));
          };
          const timer = setInterval(() => send(': heartbeat\n\n'), 15000);
          unsubscribe = this.subscribe((event) => send(`data: ${JSON.stringify(event)}\n\n`));
          signal.addEventListener('abort', stop, { once: true });
          cleanup = stop;
          this.closers.add(stop);
          send(': connected\n\n');
          if (signal.aborted) stop();
        },
        cancel: () => cleanup(),
      },
      { highWaterMark: 64 },
    );
  }
}
