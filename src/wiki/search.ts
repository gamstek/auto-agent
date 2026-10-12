import type { Knowledge } from './knowledge';

const stopWords = new Set([
  '的',
  '是',
  '了',
  '什么',
  '在',
  '有',
  '和',
  '与',
  '对',
  '从',
  'the',
  'is',
  'a',
  'an',
  'what',
  'how',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'it',
  'its',
  'in',
  'on',
  'at',
  'to',
  'for',
  'of',
  'with',
  'by',
  'this',
  'that',
  'these',
  'those',
]);
const MAX_QUERY_TOKENS = 256;
const MAX_PHRASE_OCCURRENCES = 8;
const SNIPPET_LENGTH = 220;
const weights = {
  filenameExact: 200,
  filenamePhrase: 40,
  titlePhrase: 80,
  termExact: 80,
  termPhrase: 20,
  contentPhrase: 6,
};

type SearchRecord = Knowledge['records'][number] & { source?: string };
type TokenKind = 'word' | 'bigram' | 'character';
interface Token {
  text: string;
  kind: TokenKind;
  matcher: Matcher;
}
interface Matcher {
  has(text: string): boolean;
  first(text: string): number;
  count(text: string, limit: number): number;
}
interface Field {
  name: string;
  kind: 'title' | 'term' | 'value' | 'label' | 'filename';
  text: string;
  normalized: string;
  lines: number[];
}

export function normalizeSearch(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function compile(text: string): Matcher {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alphabet = /^\d+$/.test(text) ? '0-9' : /^[a-z0-9]+$/.test(text) ? 'a-z0-9' : undefined;
  const pattern = new RegExp(
    alphabet ? `(?:^|[^${alphabet}])(${escaped})(?=$|[^${alphabet}])` : `(${escaped})`,
    'gu',
  );
  return {
    has(value) {
      pattern.lastIndex = 0;
      return pattern.test(value);
    },
    first(value) {
      pattern.lastIndex = 0;
      const match = pattern.exec(value);
      return match ? match.index + match[0].length - match[1]!.length : -1;
    },
    count(value, limit) {
      pattern.lastIndex = 0;
      let count = 0;
      while (count < limit && pattern.exec(value)) count++;
      return count;
    },
  };
}

function tokenize(query: string): { tokens: Token[]; truncated: boolean } {
  const kinds = new Map<string, TokenKind>();
  const add = (text: string, kind: TokenKind) => {
    if (text && !stopWords.has(text) && !kinds.has(text)) kinds.set(text, kind);
  };
  const parts = normalizeSearch(query).match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const part of parts) {
    if (stopWords.has(part)) continue;
    if ([...part].length > 1) add(part, 'word');
    for (const segment of part.match(/\p{Script=Han}+|[\p{Script=Latin}\p{N}]+/gu) ?? [])
      if ([...segment].length > 1) add(segment, 'word');
  }
  for (const part of parts) {
    if (stopWords.has(part)) continue;
    for (const segment of part.match(/\p{Script=Han}+/gu) ?? []) {
      const characters = [...segment];
      for (let index = 0; index < characters.length - 1; index++)
        add(characters.slice(index, index + 2).join(''), 'bigram');
    }
  }
  for (const part of parts) {
    if (stopWords.has(part)) continue;
    for (const character of part.match(/\p{Script=Han}/gu) ?? []) add(character, 'character');
  }
  return {
    tokens: [...kinds]
      .slice(0, MAX_QUERY_TOKENS)
      .map(([text, kind]) => ({ text, kind, matcher: compile(text) })),
    truncated: kinds.size > MAX_QUERY_TOKENS,
  };
}

export function queryTokens(query: string): string[] {
  return tokenize(query).tokens.map((token) => token.text);
}

function fields(record: SearchRecord): Field[] {
  const output: Field[] = [];
  const add = (name: string, kind: Field['kind'], text: string, lines: number[] = []) =>
    output.push({ name, kind, text, normalized: normalizeSearch(text), lines });
  add('title', 'title', record.title);
  const seenTerms = new Set<string>();
  for (const term of record.terms) {
    const normalized = normalizeSearch(term);
    if (seenTerms.has(normalized)) continue;
    seenTerms.add(normalized);
    add('terms', 'term', term);
  }
  for (const [name, fact] of Object.entries(record.facts)) {
    const lines = [...new Set(fact.citations.map((citation) => citation.line))].sort(
      (a, b) => a - b,
    );
    add(`facts.${name}`, 'value', fact.value, lines);
    add(`facts.${name}`, 'label', name, lines);
  }
  if (record.source) add('source', 'filename', record.source.split(/[\\/]/).at(-1)!);
  return output;
}

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
function snippet(text: string, normalizedAnchor: number): string {
  let offset = 0,
    rawAnchor = 0,
    started = false,
    whitespace = false;
  for (const segment of segmenter.segment(text)) {
    const normalized = segment.segment.normalize('NFKC').toLowerCase();
    if (/^\s+$/u.test(normalized)) {
      whitespace = started;
      continue;
    }
    if (whitespace) {
      offset++;
      whitespace = false;
    }
    if (offset + normalized.length > Math.max(0, normalizedAnchor)) {
      rawAnchor = segment.index;
      break;
    }
    offset += normalized.length;
    started = true;
  }
  const characters = [...text];
  const anchor = [...text.slice(0, rawAnchor)].length;
  const start = Math.max(0, anchor - 70);
  const end = Math.min(characters.length, start + SNIPPET_LENGTH);
  return `${start ? '…' : ''}${characters.slice(start, end).join('')}${end < characters.length ? '…' : ''}`;
}

export function createKeywordSearch(query: string) {
  const normalizedQuery = normalizeSearch(query);
  const phrase = normalizedQuery.replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '');
  const prepared = tokenize(query);
  const phraseMatcher = phrase ? compile(phrase) : undefined;
  const characterQuery = prepared.tokens.length === 1 && prepared.tokens[0]!.kind === 'character';
  const evaluate = (record: SearchRecord) => {
    const searchable = fields(record);
    const matched = new Set<string>();
    const matchedFields = new Set<string>();
    let score = 0,
      meaningful = false;
    const fieldWeights = { title: 5, term: 6, value: 1, label: 0.5, filename: 2 };
    for (const token of prepared.tokens) {
      const kinds = new Set<Field['kind']>();
      for (const field of searchable) {
        if (!token.matcher.has(field.normalized)) continue;
        kinds.add(field.kind);
        matched.add(token.text);
        matchedFields.add(field.name);
        // Single-character overlaps only refine longer queries, never establish a match alone.
        if (token.kind !== 'character' || characterQuery) meaningful = true;
      }
      const weight = token.kind === 'character' && !characterQuery ? 0.25 : 1;
      for (const kind of kinds) score += fieldWeights[kind] * weight;
    }
    if (!prepared.tokens.length || !meaningful)
      return {
        score: 0,
        searchable,
        matched,
        matchedFields,
        exactFilename: false,
        phraseMatch: false,
      };
    let exactFilename = false,
      phraseMatch = false,
      termBonus = 0,
      occurrences = 0;
    for (const field of searchable) {
      if (field.kind === 'term') {
        if (field.normalized === phrase) termBonus = Math.max(termBonus, weights.termExact);
        else if (
          [...field.normalized].length > 1 &&
          normalizedQuery.includes(field.normalized) &&
          compile(field.normalized).has(normalizedQuery)
        )
          termBonus = Math.max(termBonus, weights.termPhrase);
      }
      if (!phraseMatcher?.has(field.normalized)) continue;
      phraseMatch = true;
      if (field.kind === 'filename') {
        score += weights.filenamePhrase;
        exactFilename =
          field.normalized === phrase || field.normalized.replace(/\.(?:md|txt)$/i, '') === phrase;
        if (exactFilename) score += weights.filenameExact;
      } else if (field.kind === 'title') score += weights.titlePhrase;
      else if (field.kind === 'value')
        occurrences += phraseMatcher.count(
          field.normalized,
          MAX_PHRASE_OCCURRENCES - Math.min(occurrences, MAX_PHRASE_OCCURRENCES),
        );
    }
    score += termBonus + Math.min(occurrences, MAX_PHRASE_OCCURRENCES) * weights.contentPhrase;
    return { score, searchable, matched, matchedFields, exactFilename, phraseMatch };
  };
  return {
    tokens: prepared.tokens.map((token) => token.text),
    queryTruncated: prepared.truncated,
    score(record: SearchRecord): number {
      return evaluate(record).score;
    },
    match(record: SearchRecord) {
      const hit = evaluate(record);
      const value =
        hit.searchable.find(
          (field) => field.kind === 'value' && phraseMatcher?.has(field.normalized),
        ) ??
        hit.searchable.find(
          (field) =>
            field.kind === 'value' &&
            prepared.tokens.some(
              (token) => token.kind !== 'character' && token.matcher.has(field.normalized),
            ),
        ) ??
        hit.searchable.find(
          (field) => field.kind === 'value' && hit.matchedFields.has(field.name),
        ) ??
        hit.searchable.find(
          (field) =>
            field.kind !== 'label' &&
            prepared.tokens.some((token) => token.matcher.has(field.normalized)),
        ) ??
        hit.searchable[0]!;
      let anchor = phraseMatcher?.first(value.normalized) ?? -1;
      if (anchor < 0)
        anchor =
          prepared.tokens
            .map((token) => token.matcher.first(value.normalized))
            .find((index) => index >= 0) ?? 0;
      return {
        fields: [...hit.matchedFields].slice(0, 8),
        tokens: [...hit.matched].slice(0, 16),
        exactFilename: hit.exactFilename,
        phrase: hit.phraseMatch,
        snippet: { field: value.name, text: snippet(value.text, anchor), lines: value.lines },
      };
    },
  };
}

export function scoreRecord(record: SearchRecord, query: string): number {
  return createKeywordSearch(query).score(record);
}

export function compareSearchResults(
  a: { score: number; source: string; title: string },
  b: { score: number; source: string; title: string },
): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  const left = normalizeSearch(a.title),
    right = normalizeSearch(b.title);
  return left === right ? 0 : left < right ? -1 : 1;
}
