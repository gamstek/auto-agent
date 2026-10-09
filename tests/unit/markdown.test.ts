import { test, expect } from 'bun:test';
import { TerminalMarkdown } from '../../src/cli/markdown';
function render(text: string, color = false, chunks = [text]) {
  let output = '';
  const renderer = new TerminalMarkdown((value) => (output += value), color);
  for (const chunk of chunks) renderer.append(chunk);
  renderer.finish();
  return output;
}
test('Markdown headings emphasis lists quotes links and fenced code are readable in terminal', () => {
  const source =
    '# Heading\n\n- **item** with `code`\n> *quote*\n[link](https://example.com)\n```typescript\nconst a = "**literal**";\n```';
  const output = render(source);
  expect(output).toContain('Heading');
  expect(output).not.toContain('# Heading');
  expect(output).toContain('• item with code');
  expect(output).toContain('│ quote');
  expect(output).toContain('link (https://example.com)');
  expect(output).toContain('[typescript]');
  expect(output).toContain('"**literal**"');
  expect(output).not.toContain('```');
});
test('split Markdown streams match complete messages, including fences and final unterminated line', () => {
  const source = '# Header\n**bold**\n~~~js\nconst a=1\n~~~\nfinal';
  expect(render(source, false, [...source])).toBe(render(source));
  expect(render('**bold**', true)).toContain('\x1b[1m');
  expect(render('**bold**')).toBe('bold');
});
test('model terminal escape sequences are stripped before Markdown formatting', () => {
  expect(render('# safe\x1b[2J\n')).not.toContain('\x1b');
  expect(render('text\x1b]52;c;payload\x07')).not.toContain('payload');
});
