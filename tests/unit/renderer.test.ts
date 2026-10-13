import { test, expect } from 'bun:test';
import { Writable } from 'node:stream';
import { ReplRenderer } from '../../src/cli/renderer';
function renderer(color: boolean) {
  let output = '',
    errors = '';
  const view = new ReplRenderer(
    new Writable({
      write(chunk, _enc, done) {
        output += chunk.toString();
        done();
      },
    }),
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
