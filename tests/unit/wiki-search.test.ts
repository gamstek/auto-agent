import { expect, test } from 'bun:test';
import {
  queryTokens,
  scoreRecord,
  createKeywordSearch,
  compareSearchResults,
} from '../../src/wiki/search';
import type { Knowledge } from '../../src/wiki/knowledge';
const record: Knowledge['records'][number] = {
  title: '负极 / 石墨 / 仅需测比表面积',
  terms: ['石墨', '仅需测比表面积'],
  facts: {
    template: {
      value: 'BET测试模板（0.05-0.3）',
      citations: [{ line: 5, quote: 'BET测试模板（0.05-0.3）' }],
    },
    gas: { value: '氮气77K', citations: [{ line: 5, quote: '氮气77K' }] },
  },
  issues: ['未确认的未知样品不得套用'],
};
test('both observed failed queries retrieve compound Chinese titles and English methods in facts', () => {
  expect(scoreRecord(record, '比表面积 BET 测试 推荐 材料 脱气条件')).toBeGreaterThan(0);
  expect(
    scoreRecord(record, 'BET template recommendation material gas temperature preprocessing'),
  ).toBeGreaterThan(0);
});
test('tokenization supports Chinese partial terms, fullwidth text and case-insensitive methods', () => {
  expect(queryTokens('比表面积')).toContain('比表');
  expect(queryTokens('比表面积')).toContain('面积');
  expect(scoreRecord(record, 'ＢＥＴ')).toBeGreaterThan(0);
  expect(scoreRecord(record, '氮气')).toBeGreaterThan(0);
  expect(scoreRecord(record, '比表面积')).toBeGreaterThan(0);
});
test('unrelated materials, issue text, stopwords and partial Latin identifiers do not produce evidence', () => {
  expect(scoreRecord(record, '未知材料')).toBe(0);
  expect(scoreRecord(record, '未确认的未知样品')).toBe(0);
  expect(scoreRecord(record, 'be')).toBe(0);
  expect(scoreRecord(record, 'the and')).toBe(0);
  expect(scoreRecord(record, 'BETA')).toBe(0);
});
test('domain keywords remain searchable instead of being treated as stopwords', () => {
  for (const keyword of ['材料', '推荐', '条件', '测试'])
    expect(queryTokens(keyword)).toContain(keyword);
  expect(scoreRecord(record, '测试')).toBeGreaterThan(0);
});
test('single Chinese characters can retrieve data but character-only overlaps do not match a longer query', () => {
  const carbon = { ...record, title: '硬碳微孔分析', terms: ['硬碳', '微孔分析'] };
  expect(scoreRecord(carbon, '碳')).toBeGreaterThan(0);
  expect(scoreRecord(carbon, '孔洞')).toBe(0);
});
test('exact source filenames can retrieve compiled records with no matching record text', () => {
  const sourceRecord = {
    ...record,
    title: '石墨',
    terms: ['石墨'],
    facts: { gas: record.facts.gas! },
    source: 'builtin/BET.md',
  };
  expect(scoreRecord(sourceRecord, 'BET')).toBeGreaterThan(0);
});
test('phrase occurrence bonuses reward repeated evidence but saturate to prevent flooding', () => {
  const body = (count: number) => ({
    ...record,
    title: 'Other topic',
    terms: ['Other topic'],
    facts: {
      method: { value: Array(count).fill('BET').join(' '), citations: [{ line: 1, quote: 'BET' }] },
    },
  });
  expect(scoreRecord(body(2), 'BET')).toBeGreaterThan(scoreRecord(body(1), 'BET'));
  expect(scoreRecord(body(500), 'BET')).toBe(scoreRecord(body(10), 'BET'));
});

test('title phrases and exact aliases outrank capped body-only matches', () => {
  const query = 'BET测试模板';
  const titled = { ...record, title: query, terms: ['fixture'], facts: { gas: record.facts.gas! } };
  const bodyOnly = {
    ...record,
    title: 'Other topic',
    terms: ['fixture'],
    facts: { template: { ...record.facts.template!, value: Array(100).fill(query).join(' ') } },
  };
  expect(scoreRecord(titled, query)).toBeGreaterThan(scoreRecord(bodyOnly, query));
  const alias = { ...titled, title: 'Other topic', terms: [query] };
  expect(scoreRecord(alias, query)).toBeGreaterThan(scoreRecord(bodyOnly, query));
});
test('queries are bounded and compiled matchers can be reused without stateful regex errors', () => {
  const query = Array.from({ length: 400 }, (_, index) => `term${index}`).join(' ');
  const bounded = createKeywordSearch(query);
  expect(bounded.tokens).toHaveLength(256);
  expect(bounded.queryTruncated).toBe(true);
  const search = createKeywordSearch('BET');
  const expected = search.score(record);
  for (let index = 0; index < 10; index++) {
    expect(search.score(record)).toBe(expected);
    expect(search.match(record).snippet.lines).toEqual([5]);
  }
});
test('snippets retain original Unicode text and source lines around normalized matches', () => {
  const text = ' '.repeat(300) + '前言 '.repeat(100) + 'ＢＥＴ 氮气77K' + ' 后文'.repeat(200);
  const long = {
    ...record,
    title: 'Other topic',
    terms: ['fixture'],
    facts: { template: { ...record.facts.template!, value: text } },
  };
  const search = createKeywordSearch('BET');
  const before = JSON.stringify(long);
  const match = search.match(long);
  expect(match.snippet.text).toContain('ＢＥＴ');
  expect([...match.snippet.text].length).toBeLessThanOrEqual(222);
  expect(match.snippet.lines).toEqual([5]);
  expect(match.snippet.field).toBe('facts.template');
  expect(JSON.stringify(long)).toBe(before);
});
test('alias previews preserve casing and fullwidth metadata instead of normalized replacements', () => {
  const alias = {
    ...record,
    title: 'Other topic',
    terms: ['ＬＴＯ', 'LTO'],
    facts: { gas: record.facts.gas! },
  };
  const search = createKeywordSearch('LTO');
  expect(search.match(alias).snippet).toMatchObject({ field: 'terms', text: 'ＬＴＯ' });
  expect(search.score(alias)).toBe(search.score({ ...alias, terms: ['ＬＴＯ'] }));
});

test('field-label queries preview their cited values, and numeric units remain searchable', () => {
  const search = createKeywordSearch('template');
  expect(search.score(record)).toBeGreaterThan(0);
  expect(search.match(record).snippet).toMatchObject({
    field: 'facts.template',
    lines: [5],
    text: record.facts.template!.value,
  });
  expect(scoreRecord(record, '77 K')).toBeGreaterThan(0);
  expect(scoreRecord(record, '177')).toBe(0);
  expect(() => scoreRecord(record, '[BET]+ (0.05-0.3)')).not.toThrow();
});
test('Chinese questions can retrieve fact headings without discarding domain words', () => {
  const heading = {
    ...record,
    title: 'Other topic',
    terms: ['fixture'],
    facts: {
      预处理条件: { value: '200-300℃，2h', citations: [{ line: 5, quote: '200-300℃，2h' }] },
    },
  };
  const search = createKeywordSearch('想查预处理条件');
  expect(search.score(heading)).toBeGreaterThan(0);
  expect(search.match(heading).snippet).toMatchObject({
    field: 'facts.预处理条件',
    text: '200-300℃，2h',
    lines: [5],
  });
});

test('equal scores use stable source and title tie-breakers independent of discovery order', () => {
  const entries = [
    { score: 10, source: 'external-z/page.md', title: 'A' },
    { score: 10, source: 'builtin/page.md', title: 'B' },
    { score: 10, source: 'builtin/page.md', title: 'A' },
  ];
  expect([...entries].sort(compareSearchResults)).toEqual(
    [...entries].reverse().sort(compareSearchResults),
  );
  expect([...entries].sort(compareSearchResults)[0]!.title).toBe('A');
});

test('exact material matches outrank method-only matches and repeated terms do not inflate score', () => {
  const other = { ...record, title: '锌粉比表面积', terms: ['锌粉', '比表面积'] };
  expect(scoreRecord(record, '石墨 BET')).toBeGreaterThan(scoreRecord(other, '石墨 BET'));
  expect(scoreRecord({ ...record, terms: [...record.terms, ...record.terms] }, '石墨 BET')).toBe(
    scoreRecord(record, '石墨 BET'),
  );
});
