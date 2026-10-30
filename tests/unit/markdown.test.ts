import { test, expect } from 'bun:test';
import { TerminalMarkdown, TerminalText } from '../../src/cli/markdown';
import { stripVTControlCharacters } from 'node:util';
function render(text: string, color = false, chunks = [text], columns = 80) {
  let output = '';
  const renderer = new TerminalMarkdown((value) => (output += value), color, columns);
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

test('GFM tables render aligned Chinese and inline content instead of raw Markdown rows and blank separator lines', () => {
  const source =
    '| 字段 | 内容 |\n| :--- | :--- |\n| **样品** | 球形硅微粉 |\n| 路径 | `E:\\templates\\MESO_SILICA_01.SAM` |';
  for (const color of [false, true]) {
    const output = render(source, color);
    expect(output).toContain('┌');
    expect(output).toContain('├');
    expect(output).toContain('└');
    expect(output).toContain('球形硅微粉');
    expect(output).toContain('E:\\templates\\MESO_SILICA_01.SAM');
    expect(output).not.toContain('| :---');
    expect(output).not.toContain('**样品**');
    expect(output).not.toContain('`E:');
    const lines = stripVTControlCharacters(output).trim().split('\n');
    expect(new Set(lines.map((line) => Bun.stringWidth(line))).size).toBe(1);
    const boundaries = lines
      .filter((line) => line.startsWith('│'))
      .map((line) => {
        const parts = line.split('│');
        return parts.slice(1, -1).map((cell) => Bun.stringWidth(cell));
      });
    expect(boundaries.every((row) => JSON.stringify(row) === JSON.stringify(boundaries[0]))).toBe(
      true,
    );
    if (color) expect(output).toContain('\x1b[1m');
    else expect(output).not.toContain('\x1b');
  }
});

test('streamed tables match full messages across arbitrary deltas, CRLF, final lines and surrounding blocks', () => {
  const source =
    '以下是参数：\r\n\r\n参数 | 值\r\n--- | ---:\r\n样品 | 石墨😀\r\n质量 | **1.5 g**\r\n\r\n## 后续\r\n完成';
  for (const color of [false, true]) {
    expect(render(source, color, [...source])).toBe(render(source, color));
    for (let index = 0; index <= source.length; index++)
      expect(render(source, color, [source.slice(0, index), source.slice(index)])).toBe(
        render(source, color),
      );
  }
  expect(render(source)).toContain('后续\n完成');
});

test('table alignment markers affect cell alignment and never hide standalone horizontal rules or ordinary pipe text', () => {
  const output = render(
    'Left | Right | Center\n:--- | ---: | :---:\nx | 1 | y\nlong | 1000 | longer',
  );
  const first = output.split('\n').find((line) => line.includes('│ x'))!;
  expect(first.split('│').slice(1, -1)).toEqual([' x    ', '     1 ', '   y    ']);
  expect(render('---\n')).toBe('────────────────\n');
  expect(render('literal a | b\nnext')).toBe('literal a | b\nnext');
  expect(render('a | b')).toBe('a | b');
  expect(render('| a | b |\nnot a delimiter\n')).toBe('| a | b |\nnot a delimiter\n');
  const fenced = render('```text\n| a | b |\n| --- | --- |\n| c | d |\n```');
  expect(fenced).toContain('| --- | --- |');
  expect(fenced).not.toContain('┌');
});

test('tables wrap long values, grapheme clusters, line breaks and styled content within the terminal width', () => {
  const source =
    '| 字段 | 内容 |\n| --- | --- |\n| 值 | **这是很长的中文配置👩‍🔬以及路径ABCD_EFGH_IJKL.SAM** |\n| 换行 | 第一行<br>第二行 |\n| 管道 | a\\|b |';
  for (const color of [false, true]) {
    const output = render(source, color, [...source], 26);
    const plain = stripVTControlCharacters(output);
    expect(plain).toContain('👩‍🔬');
    expect(plain).not.toContain('<br>');
    expect(plain).toContain('第一行');
    expect(plain).toContain('第二行');
    expect(plain).toContain('a|b');
    const lines = plain.trim().split('\n');
    expect(lines.every((line) => Bun.stringWidth(line) <= 26)).toBe(true);
    expect(new Set(lines.map((line) => Bun.stringWidth(line))).size).toBe(1);
    expect(plain.replace(/[│┌┐├┤└┘┬┴┼─\s]/g, '')).toContain(
      '这是很长的中文配置👩‍🔬以及路径ABCD_EFGH_IJKL.SAM',
    );
  }
});

test('many-column tables use a readable narrow layout and large tables retain every row across bounded blocks', () => {
  const source =
    '名称 | 净样质量 | 空管质量 | 结果路径\n--- | --- | --- | ---\n石墨 | 1.5g | 29.1g | E:/SAM/x.SAM';
  const output = render(source, false, [source], 18);
  expect(output).toContain('名称: 石墨');
  expect(output).toContain('净样质量: 1.5g');
  expect(output).toContain('空管质量: 29.1g');
  expect(
    output
      .trim()
      .split('\n')
      .every((line) => Bun.stringWidth(line) <= 18),
  ).toBe(true);
  const rows = Array.from({ length: 300 }, (_value, index) => `| item-${index} | value-${index} |`);
  const large = render('| key | value |\n| --- | --- |\n' + rows.join('\n'));
  for (let index = 0; index < 300; index++) expect(large).toContain(`item-${index} `);
});

test('a block containing pipes after a table is not lost when the lexer ends the table early', () => {
  const source = '| key | value |\n| --- | --- |\n| a | b |\n<div>outside | table</div>\n后续段落';
  const output = render(source);
  expect(output).toContain('└');
  expect(output).toContain('outside | table');
  expect(output).toContain('后续段落');
  expect(render(source, false, [...source])).toBe(output);
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

test('plain reasoning emits immediately and consumes split terminal controls without buffering paragraphs', () => {
  let output = '';
  const renderer = new TerminalText((text) => {
    output += text;
  });
  renderer.append('无换行的思考');
  expect(output).toBe('无换行的思考');
  renderer.append('继续');
  expect(output).toBe('无换行的思考继续');
  for (const char of '\x1b[2J\x1b]52;c;clipboard-secret\x07\x1bPprivate\x1b\\\x9dhidden\x9c')
    renderer.append(char);
  expect(output).toBe('无换行的思考继续');
  renderer.append('\ud83d');
  renderer.append('\ude00\n下一行');
  expect(output).toBe('无换行的思考继续😀\n下一行');
  renderer.append('\x1b]unfinished-control');
  renderer.finish();
  expect(output).not.toContain('unfinished-control');
  renderer.append('完成');
  expect(output).toEndWith('下一行完成');
});
