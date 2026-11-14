import type { HttpRouteDefinition } from '@coraxjs/core/channels';

type Handler = HttpRouteDefinition['handler'];

/** Time public session operations without changing native history or stream ownership. */
export function timeHistoryRoute(handler: Handler): Handler {
  return async (request, context) => {
    if (new URL(request.url).searchParams.get('follow') !== 'false')
      return handler(request, context);

    const started = performance.now();
    const durations = { tail: 0, stream: 0 };
    const measure = async <T>(name: keyof typeof durations, operation: () => Promise<T>) => {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        durations[name] += performance.now() - start;
      }
    };
    const observed = new Proxy(context, {
      get(target, key, receiver) {
        if (key !== 'attachSession') return Reflect.get(target, key, receiver);
        return (id: string) => {
          const session = target.attachSession(id);
          return new Proxy(session, {
            get(target, key) {
              if (key === 'getStreamTailIndex')
                return () => measure('tail', () => target.getStreamTailIndex());
              if (key === 'getEventStream')
                return (...args: Parameters<typeof target.getEventStream>) =>
                  measure('stream', () => target.getEventStream(...args));
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        };
      },
    });
    const response = await handler(request, observed);
    response.headers.set('x-auto-agent-history-tail-ms', String(Math.round(durations.tail)));
    response.headers.set('x-auto-agent-history-stream-ms', String(Math.round(durations.stream)));
    response.headers.set(
      'x-auto-agent-history-handler-ms',
      String(Math.round(performance.now() - started)),
    );
    return response;
  };
}
