/** Explicit offline publication of a unified reference index. No model or equipment calls. */
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WikiLibrary, ParserRegistry, builtinParsers, type SourceInput } from '@auto-agent/wiki-core';
import { samParser } from '@auto-agent/wiki-sam';

const { values } = parseArgs({ options: {
  source: { type: 'string', multiple: true }, include: { type: 'string', multiple: true },
  output: { type: 'string' }, replace: { type: 'boolean', default: false },
} });
if (!values.source?.length || !values.output) throw new Error('Usage: bun scripts/publish-wiki.ts --source id=path [--source id=path] [--include glob] --output index.sqlite [--replace]');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const output = resolve(values.output);
const parent = await lstat(dirname(output));
if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Output parent must be a regular directory');
const existing = await Bun.file(output).exists();
if (existing && !values.replace) throw new Error('Output already exists; use --replace explicitly');
const before = existing ? hash(await readFile(output)) : null;
const sources: SourceInput[] = [];
for (const specification of values.source) {
  const separator = specification.indexOf('=');
  if (separator <= 0) throw new Error('Source must be id=path');
  const path = resolve(specification.slice(separator + 1));
  const stat = await lstat(path);
  sources.push({ id: specification.slice(0, separator), type: stat.isDirectory() ? 'directory' : 'file', path, collection: 'reference', include: values.include ?? ['**/*'] });
}
const temporary = await mkdtemp(join(dirname(output), '.publish-'));
let library: WikiLibrary | undefined;
try {
  const registry = () => new ParserRegistry([...builtinParsers, samParser]);
  library = new WikiLibrary(join(temporary, 'working', 'library.sqlite'), registry());
  const result = await library.build(sources, new AbortController().signal);
  if (!result.parsed || result.unsupported) throw new Error('Publish only an explicitly selected set of fully supported documents');
  const staged = join(temporary, 'library.sqlite');
  library.exportBundle(staged);
  await library.close();
  library = new WikiLibrary(join(temporary, 'verify', 'library.sqlite'), registry(), [{ id: 'reference', path: staged }]);
  if (!library.lint().healthy) throw new Error('Published index is incomplete');
  const records = library.catalog().sources.reduce((sum, source) => sum + source.documents, 0);
  if (records !== result.parsed) throw new Error('Published index coverage differs from the source build');
  await library.close(); library = undefined;
  if (before ? hash(await readFile(output)) !== before : await Bun.file(output).exists()) throw new Error('Destination changed during publication');
  const bytes = await readFile(staged);
  if (bytes.length > 256 * 1024 * 1024) throw new Error('Published index exceeds its size limit');
  await rename(staged, output);
  console.log(JSON.stringify({ ...result, output, bytes: bytes.length, sha256: hash(bytes), verified: true }, null, 2));
} finally { await library?.close(); await rm(temporary, { recursive: true, force: true }); }
