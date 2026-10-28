import { inspectSam } from '../../../skills/device-automation/scripts/lib/sam.js';
import { normalizeSearch, queryTokens } from '../search';
import type { IndexedSource, Evidence } from './schema';
import { AppError } from '../../shared/types';

export function searchBody(record: IndexedSource): string {
  const text = [
    record.path,
    record.metadata.materialHint,
    ...Object.values(record.metadata).filter((v) => typeof v === 'string'),
    ...record.evidence.map((e) => e.text),
  ].join('\n');
  const tokens = new Set<string>();
  for (const chunk of text.match(/[\s\S]{1,100}/gu) ?? [])
    for (const token of queryTokens(chunk)) tokens.add(token);
  return `${normalizeSearch(text)}\n${[...tokens].join(' ')}`;
}
export function tokensFor(query: string): string[] {
  const tokens = queryTokens(query),
    words = tokens.filter((token) => [...token].length > 1);
  return (words.length ? words : tokens).slice(0, 32);
}
export function chooseEvidence(evidence: Evidence[], query: string, limit: number): Evidence[] {
  const tokens = tokensFor(query);
  return evidence
    .map((value, index) => ({
      value,
      index,
      score: tokens.reduce(
        (sum, token) => sum + (normalizeSearch(value.text).includes(token) ? 1 : 0),
        0,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((v) => v.value);
}
export async function extract(
  record: IndexedSource,
  absolutePath: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<IndexedSource> {
  signal.throwIfAborted();
  const status =
    bytes.length >= 8
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, false)
      : 0;
  const product =
    status >= 0x2000 && status < 0x3000 ? 'g12' : status >= 0x1000 && status < 0x2000 ? 'g5' : null;
  if (!product) {
    record.state = 'unsupported';
    record.issues.push(
      'UNSUPPORTED_TEMPLATE: a documented SAM/SMP product profile could not be determined',
    );
    return record;
  }
  const result = await inspectSam({ path: absolutePath, product });
  if (result.file.sha256 !== record.sha256)
    throw new AppError(
      'wiki_index_changed',
      'Template changed during extraction; previous index retained',
    );
  const value = (field: string) =>
    typeof result.facts[field]?.value === 'string' ? (result.facts[field]!.value as string) : null;
  record.configuration = result;
  record.metadata = {
    ...record.metadata,
    product,
    productBasis: 'status-family',
    gas: value('gasMnemonic'),
    analysisType: value('analysisType'),
    pressureMode: value('pressureMode'),
    clientVersion: value('clientVersion'),
    temperatureK:
      typeof result.facts.temperatureK?.value === 'number' ? result.facts.temperatureK.value : null,
    fileState: result.status.state,
    sampleName: typeof result.identity.sampleName === 'string' ? result.identity.sampleName : null,
    uuid: result.identity.uuid,
  };
  record.evidence = Object.values(result.facts)
    .filter(
      (fact) =>
        fact.presence !== 'missing' &&
        (fact.rawValue === null || ['string', 'number', 'boolean'].includes(typeof fact.rawValue)),
    )
    .map((fact) => ({
      kind: 'json-path',
      text: String(fact.rawValue).slice(0, 1000),
      path: fact.source,
    }));
  record.issues.push(...result.warnings.map((v) => `${v.code}: ${v.message}`));
  record.state = 'parsed';
  signal.throwIfAborted();
  return record;
}
