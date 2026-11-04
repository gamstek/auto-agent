import type { WikiLibrary } from '@auto-agent/wiki-core';
import { readSchema, searchSchema, WikiError } from '@auto-agent/wiki-core/contracts';
import { AppError } from '../shared/types';
import type { Config } from '../config';
import { z } from 'zod';

export async function wikiCommand(
  library: WikiLibrary | undefined,
  config: Config,
  args: string[],
  signal: AbortSignal,
) {
  if (!library || !config.wiki)
    throw new AppError(
      'wiki_configuration',
      'The wiki command requires unified wiki.sources configuration',
    );
  const [action, ...rest] = args;
  try {
    if (action === 'catalog' && !rest.length) return library.catalog();
    if (action === 'lint' && !rest.length) return library.lint();
    if (action === 'refresh' && !rest.length)
      return await library.build(config.wiki.sources, signal);
    if (action === 'search' && rest.length) {
      const query = rest.join(' ');
      return library.search(
        searchSchema.parse(query.startsWith('{') ? JSON.parse(query) : { query }),
      );
    }
    if (action === 'read' && rest.length === 1)
      return library.read(readSchema.parse(JSON.parse(rest[0]!)));
    throw new AppError(
      'usage',
      'Usage: wiki catalog | lint | refresh | search <query-or-JSON> | read <JSON-with-reference>',
    );
  } catch (error) {
    if (error instanceof WikiError) throw new AppError(error.code, error.message, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new AppError('wiki_input', 'Invalid Wiki command input');
    throw error;
  }
}
