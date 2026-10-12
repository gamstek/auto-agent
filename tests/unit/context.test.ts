import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { fitModelContext, estimatedTokens } from '../../src/agent/context';
function pair(name: string, id: string, input: unknown, value: any, text = false): ModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolName: name, toolCallId: id, input }] },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolName: name,
          toolCallId: id,
          output: text ? { type: 'text', value } : { type: 'json', value },
        },
      ],
    },
  ];
}
test('context preserves current request, loaded guidance, resources, cited knowledge and newest results', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'System rules' },
    { role: 'user', content: 'Old conversation '.repeat(2000) },
    { role: 'assistant', content: 'Old answer' },
    { role: 'user', content: 'Current instrument workflow' },
    ...pair('skill', 'skill-id', { name: 'example' }, 'Trusted skill guidance', true),
    ...pair('read', 'resource-id', { skill: 'example', path: 'interfaces.md' }, 'Interface schema'),
    ...pair(
      'wiki',
      'wiki-id',
      { query: '石墨' },
      { results: [{ source: 'source.md', citations: [1] }] },
    ),
    ...pair('execute_skill_script', 'latest-id', { args: ['status'] }, { stdout: 'Current state' }),
  ];
  const before = JSON.stringify(messages);
  const fitted = fitModelContext(messages, 2000, 100);
  expect(fitted.removedMessages).toBeGreaterThan(0);
  expect(fitted.estimatedTokens).toBeLessThanOrEqual(2000);
  for (const value of [
    'Current instrument workflow',
    'Trusted skill guidance',
    'Interface schema',
    'source.md',
    'Current state',
  ])
    expect(JSON.stringify(fitted.messages)).toContain(value);
  expect(JSON.stringify(fitted.messages)).not.toContain('Old conversation');
  expect(JSON.stringify(messages)).toBe(before);
});
test('compaction keeps tool calls and their complete result groups together', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'Current request' }];
  for (let index = 0; index < 8; index++)
    messages.push(
      ...pair('execute_skill_script', String(index), {}, { data: 'payload'.repeat(180) }),
    );
  const fitted = fitModelContext(messages, 1900);
  const calls = fitted.messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === 'tool-call').map((part) => part.toolCallId)
      : [],
  );
  const results = fitted.messages.flatMap((message) =>
    message.role === 'tool'
      ? message.content.filter((part) => part.type === 'tool-result').map((part) => part.toolCallId)
      : [],
  );
  expect(calls).toEqual(results);
  expect(calls).toContain('7');
  expect(calls.length).toBeLessThan(8);
});
test('small contexts are unchanged and essential oversized inputs fail without truncating facts', () => {
  const small: ModelMessage[] = [{ role: 'user', content: 'hello' }];
  expect(fitModelContext(small, 100).messages).toBe(small);
  expect(() =>
    fitModelContext([{ role: 'system', content: 'Critical rules'.repeat(1000) }, ...small], 100),
  ).toThrow('Essential instructions');
  expect(() => fitModelContext(small, 100, 200)).toThrow('maxContextTokens');
  expect(estimatedTokens('中文')).toBeGreaterThan(estimatedTokens('ab'));
});
