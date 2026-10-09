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
  r.event('tool.started', { name: 'load_skill', skill: 'sum-values', status: 'running' });
  r.event('tool.completed', { name: 'load_skill', status: 'completed', durationMs: 10 });
  r.event('tool.failed', { name: 'execute_skill_script', status: 'timeout', message: 'Timed out' });
  r.view.failure('bad\x1b[2Jpayload');
  expect(r.output()).toContain('\x1b[32m');
  expect(r.output()).toContain('\x1b[33m');
  expect(r.output()).toContain('running');
  expect(r.output()).toContain('4 tokens');
  expect(r.output()).toContain('timeout');
  expect(r.errors()).not.toContain('\x1b[2J');
});
test('plain renderer omits ANSI for redirected output and closes text before tool lines', () => {
  const r = renderer(false);
  r.event('message.part.delta', { delta: 'answer' });
  r.event('tool.started', { name: 'list_skills' });
  r.view.failure('error');
  expect(r.output()).toContain('assistant > answer\n[tool]');
  expect(r.output()).not.toContain('\x1b');
  expect(r.errors()).not.toContain('\x1b');
});
