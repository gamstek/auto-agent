import { basename } from 'node:path';
import { WikiError, type DocumentParser, type ParsedUnit } from './contracts';

function decode(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WikiError('source_encoding', 'Document is not valid UTF-8');
  }
}
function textParser(id: string, mediaType: string, extension: RegExp): DocumentParser {
  return {
    id,
    version: '1',
    fields: [],
    supports: (path) => extension.test(path),
    async parse(source, { signal }) {
      const lines = decode(source.bytes).split(/\r?\n/);
      const units: ParsedUnit[] = [];
      let start = 1,
        chunk: string[] = [],
        bytes = 0;
      for (const [index, line] of lines.entries()) {
        signal.throwIfAborted();
        const size = Buffer.byteLength(line) + 1;
        if (size > 16384)
          throw new WikiError(
            'source_line_limit',
            'A source line exceeds 16 KiB; it was not silently truncated',
          );
        if (chunk.length && (chunk.length >= 40 || bytes + size > 8192)) {
          units.push({ text: chunk.join('\n'), locator: { kind: 'lines', start, end: index } });
          chunk = [];
          bytes = 0;
          start = index + 1;
        }
        chunk.push(line);
        bytes += size;
      }
      if (chunk.length)
        units.push({
          text: chunk.join('\n'),
          locator: { kind: 'lines', start, end: lines.length },
        });
      return { title: basename(source.path), mediaType, units, attributes: {}, issues: [] };
    },
  };
}
export const textParserDefinition = textParser('builtin.text', 'text/plain', /\.txt$/i);
export const markdownParser = textParser('builtin.markdown', 'text/markdown', /\.(md|markdown)$/i);
export const jsonParser: DocumentParser = {
  id: 'builtin.json',
  version: '1',
  fields: [],
  supports: (path) => /\.json$/i.test(path),
  async parse(source, { signal }) {
    let value: unknown;
    try {
      value = JSON.parse(decode(source.bytes));
    } catch (error) {
      if (error instanceof WikiError) throw error;
      throw new WikiError('source_json', 'Document is not valid JSON');
    }
    const units: ParsedUnit[] = [];
    const visit = (item: unknown, pointer: string, depth: number) => {
      signal.throwIfAborted();
      if (depth > 32 || units.length >= 10000)
        throw new WikiError('source_structure_limit', 'JSON exceeds structural limits');
      const serialized = JSON.stringify(item);
      if (Buffer.byteLength(serialized) <= 4096) {
        units.push({
          text: `${pointer || '/'}\n${serialized}`,
          locator: { kind: 'json-pointer', pointer },
          data: item,
        });
        return;
      }
      if (item === null || typeof item !== 'object')
        throw new WikiError('source_value_limit', 'JSON scalar exceeds unit limit');
      for (const [key, child] of Object.entries(item))
        visit(child, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, depth + 1);
    };
    visit(value, '', 0);
    return {
      title: basename(source.path),
      mediaType: 'application/json',
      units,
      attributes: {},
      issues: [],
    };
  },
};
export const builtinParsers: readonly DocumentParser[] = [
  textParserDefinition,
  markdownParser,
  jsonParser,
];
