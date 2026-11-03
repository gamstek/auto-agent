import { createHash } from 'node:crypto';
import { decodeSam, summarizeSam } from './sam';
import { normalizeSearch, queryTokens } from '../search';
import type { IndexedSource, Evidence } from './schema';
import { AppError } from '../../shared/types';
import { extractReference, referenceEvidence } from './reference';

export function searchBody(record: IndexedSource): string {
  const text = [
    record.path,
    record.metadata.materialHint,
    ...Object.values(record.metadata).filter((v) => typeof v === 'string'),
    ...record.evidence
      .filter((e) => e.active !== false && e.scope !== 'uninterpreted')
      .map((e) => e.text),
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
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<IndexedSource> {
  signal.throwIfAborted();
  if (createHash('sha256').update(bytes).digest('hex') !== record.sha256)
    throw new AppError(
      'wiki_index_changed',
      'Template byte snapshot does not match its source hash; previous index retained',
    );
  const decoded = decodeSam(bytes);
  const { root, product } = decoded;
  const result = summarizeSam(decoded, bytes, record.path);
  const value = (field: string) =>
    typeof result.facts[field]?.value === 'string' ? (result.facts[field]!.value as string) : null;
  const referenceSettings = extractReference(root, product);
  record.configuration = { ...result, referenceSettings };
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
    labType: Number.isInteger(root.labType) ? root.labType : null,
    collectionMode: value('collectionMode'),
    hasPretreatment: Object.values(referenceSettings.groups.pretreatment!.fields).some(
      (field) => typeof field.value === 'string' && field.value.trim().length > 0,
    ),
    selectedReports: referenceSettings.reports
      .filter((report) => report.selected === true)
      .map(({ type, name }) => ({ type, name })),
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
  record.evidence.push(...referenceEvidence(referenceSettings));
  record.issues.push(...referenceSettings.issues);
  record.issues.push(...result.warnings.map((v) => `${v.code}: ${v.message}`));
  record.state = 'parsed';
  signal.throwIfAborted();
  return record;
}
