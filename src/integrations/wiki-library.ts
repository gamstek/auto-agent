import { join } from 'node:path';
import { builtinParsers, ParserRegistry, WikiLibrary } from '@auto-agent/wiki-core';
import { samParser } from '@auto-agent/wiki-sam';
import type { Config } from '../config';
import { AppError } from '../shared/types';
import { materializeBuiltinIndex } from '../shared/builtin-index';

/** The application registers available parsers. Core indexing has no domain knowledge. */
export function createWikiLibrary(config: Config): WikiLibrary {
  const available = [...builtinParsers, samParser];
  const requested = config.wiki.parsers;
  if (requested?.some((id) => !available.some((parser) => parser.id === id)))
    throw new AppError('wiki_parser', 'Configuration requests an unregistered Wiki parser');
  return new WikiLibrary(
    join(config.dataDir, 'wiki', 'library.sqlite'),
    new ParserRegistry(
      requested ? available.filter((parser) => requested.includes(parser.id)) : available,
    ),
    config.builtinWiki ? [{ id: 'builtin-reference', path: materializeBuiltinIndex(config.dataDir) }] : [],
  );
}
