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
const summarize = async () => ({
  text: 'Earlier conversation remains unresolved.',
  usage: { totalTokens: 10, inputTokens: 8, outputTokens: 2 },
});
const options = () => ({ signal: new AbortController().signal, summarize });

test('context preserves current request, loaded guidance, resources, cited knowledge and newest results', async () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'System rules' },
    { role: 'user', content: 'Old conversation '.repeat(240) },
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
    ...pair('execute_script', 'latest-id', { args: ['status'] }, { stdout: 'Current state' }),
  ];
  const before = JSON.stringify(messages);
  const fitted = await fitModelContext(messages, 2000, 100, options());
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
test('compression keeps protected tool calls and their complete result groups together', async () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'Current request' }];
  for (let index = 0; index < 8; index++)
    messages.push(...pair('execute_script', String(index), {}, { data: 'payload'.repeat(180) }));
  const fitted = await fitModelContext(messages, 1900, 0, options());
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
test('small contexts are unchanged and essential oversized inputs fail without truncating facts', async () => {
  const small: ModelMessage[] = [{ role: 'user', content: 'hello' }];
  expect((await fitModelContext(small, 100)).messages).toBe(small);
  await expect(
    fitModelContext([{ role: 'system', content: 'Critical rules'.repeat(1000) }, ...small], 100),
  ).rejects.toThrow('Essential instructions');
  await expect(fitModelContext(small, 100, 200)).rejects.toThrow('maxInputTokens');
  expect(estimatedTokens('中文')).toBeGreaterThan(estimatedTokens('ab'));
});

test('compression retains reasoning with protected tool groups and represents summaries as user data', async () => {
  const messages: ModelMessage[] = [{ role: 'system', content: 'Rules' }];
  for (let index = 0; index < 8; index++)
    messages.push(
      { role: 'user', content: `Old ${index}: ${'history '.repeat(100)}` },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: `Old reasoning ${index}` },
          { type: 'text', text: 'Old answer' },
        ],
      },
    );
  messages.push(
    { role: 'user', content: 'Current request' },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'Protected reasoning for skill activation' },
        { type: 'tool-call', toolCallId: 'load', toolName: 'skill', input: { name: 'example' } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'load',
          toolName: 'skill',
          output: { type: 'text', value: 'Trusted skill guidance' },
        },
      ],
    },
  );
  const fitted = await fitModelContext(messages, 1600, 0, options());
  expect(fitted.removedMessages).toBeGreaterThan(0);
  expect(fitted.messages).toContainEqual(messages.at(-2)!);
  const summary = fitted.messages.find(
    (message) =>
      typeof message.content === 'string' && message.content.startsWith('[Historical summary'),
  );
  expect(summary?.role).toBe('user');
  const next = await fitModelContext(
    [...fitted.messages, { role: 'user', content: 'Next request' }],
    1600,
    0,
    options(),
  );
  expect(JSON.stringify(next.messages)).toContain('Protected reasoning for skill activation');
});
