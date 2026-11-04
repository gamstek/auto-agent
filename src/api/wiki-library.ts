import { WikiError, readSchema } from '@auto-agent/wiki-core/contracts';
import type { AgentService } from '../agent';
import { AppError } from '../shared/types';
import { z } from 'zod';

export async function libraryRoute(
  service: AgentService,
  request: Request,
  url: URL,
  body: () => Promise<Record<string, unknown>>,
  json: (value: unknown, status?: number) => Response,
): Promise<Response | undefined> {
  const library = service.library;
  if (!library || !url.pathname.startsWith('/wiki')) return undefined;
  try {
    if (
      request.method === 'GET' &&
      ['/wiki', '/wiki/catalog', '/wiki/sources'].includes(url.pathname)
    )
      return json(library.catalog());
    if (request.method === 'GET' && url.pathname === '/wiki/lint') return json(library.lint());
    if (request.method === 'GET' && url.pathname === '/wiki/documents') {
      const input = z
        .object({
          offset: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(100).default(100),
        })
        .parse(Object.fromEntries(url.searchParams));
      return json({
        documents: library.documents(
          url.searchParams.get('sourceId') ?? undefined,
          input.offset,
          input.limit,
        ),
      });
    }
    if (request.method === 'POST' && url.pathname === '/wiki/search')
      return json(library.search(await body()));
    if (request.method === 'POST' && url.pathname === '/wiki/read')
      return json(library.read(readSchema.parse(await body())));
    if (request.method === 'POST' && url.pathname === '/wiki/builds') {
      z.object({})
        .strict()
        .parse(await body());
      return json(await service.refreshLibrary(request.signal));
    }
    throw new AppError(
      'wiki_protocol',
      'Unified Wiki supports catalog, documents, search, read and explicit builds',
      404,
    );
  } catch (error) {
    if (error instanceof WikiError) throw new AppError(error.code, error.message, error.status);
    if (error instanceof z.ZodError) throw new AppError('wiki_input', 'Invalid Wiki request');
    throw error;
  }
}
