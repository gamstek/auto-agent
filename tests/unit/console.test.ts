import { test, expect } from 'bun:test';
import { Writable } from 'node:stream';
import { ConsoleOutput } from '../../src/shared/console';
test('warning uses yellow, never red, and plain text when colors are disabled', () => {
  let text = '';
  const output = new Writable({
    write(chunk, _enc, done) {
      text += chunk.toString();
      done();
    },
  });
  new ConsoleOutput(output, output, true).warn('test');
  expect(text).toContain('\x1b[33m');
  expect(text).not.toContain('\x1b[31m');
  text = '';
  new ConsoleOutput(output, output, false).warn('test');
  expect(text).toBe('[warn] test\n');
});
test('console separates diagnostics from stdout data and strips terminal controls', () => {
  let stdout = '',
    stderr = '';
  const capture = (write: (text: string) => void) =>
    new Writable({
      write(chunk, _encoding, done) {
        write(chunk.toString());
        done();
      },
    });
  const view = new ConsoleOutput(
    capture((text) => {
      stdout += text;
    }),
    capture((text) => {
      stderr += text;
    }),
  );
  view.info('Configuration: config.json');
  view.warn('warning');
  view.error('bad\x1b[2Jpayload');
  view.text('help');
  view.json({ content: 'reply' });
  expect(stdout).toBe('help\n{"content":"reply"}\n');
  expect(stderr).toBe('[info] Configuration: config.json\n[warn] warning\n[error] badpayload\n');
  expect(stdout + stderr).not.toContain('\x1b');
});
