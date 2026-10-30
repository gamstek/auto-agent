import { test, expect } from 'bun:test';
import { Writable } from 'node:stream';
import { ReplRenderer } from '../../src/cli/renderer';
function renderer(color: boolean, columns?: number) {
  let output = '',
    errors = '';
  const view = new ReplRenderer(
    Object.assign(
      new Writable({
        write(chunk, _enc, done) {
          output += chunk.toString();
          done();
        },
      }),
      { columns },
    ),
    new Writable({
      write(chunk, _enc, done) {
        errors += chunk.toString();
        done();
      },
    }),
    color,
  );
  const event = (type: string, properties: Record<string, unknown>) =>
    view.event({ type, properties, sessionId: 's', messageId: 'm' });
  return { view, event, output: () => output, errors: () => errors };
}
test('renderer distinguishes roles and shows model/tool progress without injecting terminal escapes', () => {
  const r = renderer(true);
  expect(r.view.prompt()).toContain('\x1b[36m');
  r.event('model.started', { step: 1 });
  r.event('message.part.delta', { delta: 'Hello' });
  r.event('model.completed', { step: 1, totalTokens: 4, durationMs: 12 });
  r.event('tool.started', { name: 'skill', skill: 'sum-values', status: 'running' });
  r.event('tool.completed', { name: 'skill', status: 'completed', durationMs: 10 });
  r.event('tool.failed', { name: 'execute_script', status: 'timeout', message: 'Timed out' });
  r.view.failure('bad\x1b[2Jpayload');
  expect(r.output()).toContain('\x1b[32m');
  expect(r.errors()).toContain('\x1b[90m');
  expect(r.errors()).toContain('running');
  expect(r.errors()).toContain('4 tokens');
  expect(r.errors()).toContain('timeout');
  expect(r.output()).not.toContain('[model]');
  expect(r.errors()).not.toContain('\x1b[2J');
});

test('streaming and history tables use the output width and finish before tool progress', () => {
  const source =
    '| 字段 | 值 |\n| --- | --- |\n| 样品 | 球形硅微粉 |\n| 路径 | E:/templates/MESO_SILICA_01.SAM |';
  const streamed = renderer(false, 34);
  for (const delta of [...source]) streamed.event('message.part.delta', { delta });
  streamed.event('tool.started', { name: 'execute_script', skill: 'device-automation' });
  const history = renderer(false, 34);
  history.view.history({
    id: 'a',
    sessionId: 's',
    role: 'assistant',
    content: source,
    createdAt: 0,
  });
  const streamedTable = streamed.output().slice(streamed.output().indexOf('┌')).trim();
  const historyTable = history.output().slice(history.output().indexOf('┌')).trim();
  expect(streamedTable).toBe(historyTable);
  expect(streamed.output()).toContain('assistant > \n┌');
  expect(history.output()).toContain('assistant: \n┌');
  expect(streamedTable.split('\n').every((line) => Bun.stringWidth(line) <= 34)).toBe(true);
  expect(streamed.errors()).toContain('[tool] execute_script');
  expect(streamed.output()).not.toContain('[tool]');
});
test('renderer distinguishes cumulative run tokens from each model request and reports compaction', () => {
  const r = renderer(false);
  r.event('model.completed', {
    step: 6,
    totalTokens: 8050,
    runTokens: 36596,
    inputTokens: 8000,
    outputTokens: 50,
    durationMs: 1341,
  });
  r.event('context.prepared', { estimatedInputTokens: 15000, maxInputTokens: 16000 });
  r.event('context.compressed', {
    removedMessages: 8,
    estimatedInputTokens: 12000,
    inputTokenLimit: 16000,
    totalTokens: 350,
  });
  expect(r.errors()).toContain('8050 tokens · input 8000 / output 50 · run 36596');
  expect(r.errors()).toContain('estimated input 15000/16000');
  expect(r.errors()).toContain('summarized 8 earlier messages');
  expect(r.errors()).toContain('summary 350 tokens');
});

test('plain renderer omits ANSI for redirected output and closes text before tool lines', () => {
  const r = renderer(false);
  r.event('message.part.delta', { delta: 'answer' });
  r.event('tool.started', { name: 'skill', skill: 'hello-world' });
  r.view.failure('error');
  expect(r.output()).toContain('assistant > answer\n');
  expect(r.errors()).toContain('[tool]');
  expect(r.output()).not.toContain('[tool]');
  expect(r.output()).not.toContain('\x1b');
  expect(r.errors()).not.toContain('\x1b');
});

test('reasoning is streamed separately and closes on answer, tool, failure and completion boundaries', () => {
  for (const color of [false, true]) {
    const r = renderer(color);
    r.event('message.reasoning.delta', { delta: 'Check ' });
    expect(r.errors()).toContain('think > ');
    expect(r.errors()).toContain('Check ');
    r.event('message.reasoning.delta', { delta: 'inputs\x1b[2J' });
    expect(r.errors()).toContain('Check inputs');
    expect(r.output()).toBe('');
    r.event('message.part.delta', { delta: 'answer' });
    r.event('message.reasoning.delta', { delta: 'Check result' });
    r.event('tool.started', { name: 'read' });
    r.event('message.reasoning.delta', { delta: 'Partial' });
    r.event('model.failed', { status: 'cancelled', durationMs: 1 });
    r.event('message.part.delta', { delta: 'next answer' });
    r.event('message.completed', {});
    expect(r.errors()).toContain('think > ');
    expect(r.errors()).toContain('Check inputs');
    expect(r.errors()).toContain('Check result\n');
    expect(r.errors()).toContain('Partial\n');
    expect(r.errors()).not.toContain('\x1b[2J');
    expect(r.errors()).not.toContain('next answer');
    expect(r.output()).toContain('answer\n');
    expect(r.output()).not.toContain('Check inputs');
    if (!color) expect(r.errors()).not.toContain('\x1b');
  }
});
