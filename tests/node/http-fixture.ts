import { createServer } from 'node:http';
import { once } from 'node:events';

/** Loopback-only fake manufacturer/model transport; never used by application code. */
export async function listenFetch(handler: (request: Request) => Promise<Response>) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const response = await handler(
        new Request(`http://127.0.0.1${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(!['GET', 'HEAD'].includes(incoming.method ?? 'GET')
            ? { body: Buffer.concat(chunks) }
            : {}),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    async stop() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
