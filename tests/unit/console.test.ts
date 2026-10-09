import { test, expect } from 'bun:test';
import { Writable } from 'node:stream';
import { warning } from '../../src/shared/console';
test('warning uses yellow, never red, and plain text when colors are disabled', () => {
  let text = '';
  const output = new Writable({
    write(chunk, _enc, done) {
      text += chunk.toString();
      done();
    },
  });
  warning('test', output, true);
  expect(text).toContain('\x1b[33m');
  expect(text).not.toContain('\x1b[31m');
  text = '';
  warning('test', output, false);
  expect(text).toBe('Warning: test\n');
});
