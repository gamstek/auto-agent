import { marked, type Token, type Tokens } from 'marked';
import { stripVTControlCharacters } from 'node:util';
export function safeTerminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// Plain streaming text: emit immediately while consuming terminal controls
// across delta boundaries (including OSC/DCS strings split over many chunks).
export class TerminalText {
  private state: 'text' | 'escape' | 'intermediate' | 'csi' | 'string' | 'string-escape' = 'text';
  private surrogate = '';
  constructor(private write: (text: string) => void) {}
  append(text: string): void {
    let output = '';
    for (const char of text) {
      if (this.state === 'string' || this.state === 'string-escape') {
        if (char === '\x07' || char === '\x9c' || (this.state === 'string-escape' && char === '\\'))
          this.state = 'text';
        else this.state = char === '\x1b' ? 'string-escape' : 'string';
        continue;
      }
      if (this.state === 'csi') {
        if (char === '\x1b') this.state = 'escape';
        else if (/^[\x40-\x7e]$/.test(char)) this.state = 'text';
        continue;
      }
      if (this.state === 'intermediate') {
        if (char === '\x1b') this.state = 'escape';
        else if (/^[\x30-\x7e]$/.test(char)) this.state = 'text';
        continue;
      }
      if (this.state === 'escape') {
        if (char === '[') this.state = 'csi';
        else if (']P^_X'.includes(char)) this.state = 'string';
        else if (/^[\x20-\x2f]$/.test(char)) this.state = 'intermediate';
        else if (char !== '\x1b') this.state = 'text';
        continue;
      }
      if (char === '\x1b') this.state = 'escape';
      else if (char === '\x9b') this.state = 'csi';
      else if (/[\x90\x98\x9d-\x9f]/.test(char)) this.state = 'string';
      else if (char === '\n' || char === '\t' || !/[\x00-\x1f\x7f-\x9f]/.test(char)) output += char;
    }
    if (!output) return;
    output = this.surrogate + output;
    this.surrogate = /[\ud800-\udbff]$/.test(output) ? output.slice(-1) : '';
    if (this.surrogate) output = output.slice(0, -1);
    if (output) this.write(output);
  }
  finish(): void {
    if (this.surrogate) this.write('\ufffd');
    this.surrogate = '';
    this.state = 'text';
  }
}

function inline(tokens: Token[], color: boolean): string {
  const decorate = (text: string, code: number) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  return tokens
    .map((token) => {
      if (token.type === 'strong') return decorate(inline(token.tokens ?? [], color), 1);
      if (token.type === 'em') return decorate(inline(token.tokens ?? [], color), 3);
      if (token.type === 'del') return decorate(inline(token.tokens ?? [], color), 9);
      if (token.type === 'codespan') return decorate(token.text, 36);
      if (token.type === 'link')
        return `${decorate(inline(token.tokens ?? [], color), 4)} (${token.href})`;
      if (token.type === 'image') return `[image: ${token.text}] (${token.href})`;
      if (token.type === 'br' || (token.type === 'html' && /^<br\s*\/?>$/i.test(token.raw)))
        return '\n';
      if ('tokens' in token && token.tokens) return inline(token.tokens, color);
      return 'text' in token ? token.text : token.raw;
    })
    .join('');
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const displayWidth = (text: string) => Bun.stringWidth(text);

/** Wrap display cells, preserving graphemes and resetting styles before padding. */
function wrapCell(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '',
    used = 0,
    style = '';
  const flush = () => {
    lines.push(line + (style ? '\x1b[0m' : ''));
    line = style;
    used = 0;
  };
  for (const part of text.replace(/\t/g, '    ').split(/(\x1b\[[0-9;]*m)/g)) {
    if (/^\x1b\[[0-9;]*m$/.test(part)) {
      style = part === '\x1b[0m' ? '' : style + part;
      line += part;
      continue;
    }
    for (const { segment } of graphemes.segment(part)) {
      if (segment === '\n') {
        flush();
        continue;
      }
      const size = displayWidth(segment);
      if (used && used + size > width) flush();
      line += segment;
      used += size;
    }
  }
  lines.push(line + (style ? '\x1b[0m' : ''));
  return lines;
}

function renderTable(table: Tokens.Table, color: boolean, columns: number): string {
  const rows = [table.header, ...table.rows].map((row) =>
    row.map((cell) => inline(cell.tokens, color)),
  );
  const count = table.header.length;
  const budget = columns - count * 3 - 1;
  if (budget < count * 2) {
    // A many-column table cannot fit even with wrapping. Keep every cell in a
    // labelled row layout rather than truncating values or overflowing sideways.
    return table.rows.length
      ? rows
          .slice(1)
          .map((row) =>
            row
              .map((cell, index) => wrapCell(`${rows[0]![index]}: ${cell}`, columns).join('\n'))
              .join('\n'),
          )
          .join('\n\n')
      : rows[0]!.flatMap((cell) => wrapCell(cell, columns)).join('\n');
  }
  const natural = table.header.map((_cell, index) =>
    Math.max(2, ...rows.flatMap((row) => (row[index] ?? '').split('\n').map(displayWidth))),
  );
  const widths = natural.map(() => 2);
  let remaining = budget - count * 2;
  while (remaining > 0) {
    let changed = false;
    for (let index = 0; index < count && remaining; index++) {
      if (widths[index]! < natural[index]!) {
        widths[index]!++;
        remaining--;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const border = (left: string, middle: string, right: string) =>
    left + widths.map((width) => '─'.repeat(width + 2)).join(middle) + right;
  const output = [border('┌', '┬', '┐')];
  for (const [index, row] of rows.entries()) {
    const cells = widths.map((width, cell) => wrapCell(row[cell] ?? '', width));
    const height = Math.max(...cells.map((cell) => cell.length));
    for (let line = 0; line < height; line++) {
      output.push(
        '│' +
          cells
            .map((cell, column) => {
              const text = cell[line] ?? '';
              const padding = Math.max(0, widths[column]! - displayWidth(text));
              const alignment = table.align[column];
              const left =
                alignment === 'right'
                  ? padding
                  : alignment === 'center'
                    ? Math.floor(padding / 2)
                    : 0;
              return ` ${' '.repeat(left)}${text}${' '.repeat(padding - left)} `;
            })
            .join('│') +
          '│',
      );
    }
    if (index === 0) output.push(border('├', '┼', '┤'));
  }
  output.push(border('└', '┴', '┘'));
  return output.join('\n');
}

export class TerminalMarkdown {
  private pending = '';
  private fence: { character: string; length: number } | undefined;
  private candidate?: { text: string; newline: boolean };
  private table?: string[];
  private written = false;
  constructor(
    private write: (text: string) => void,
    private color: boolean,
    private columns: number | (() => number) = 80,
  ) {}
  append(text: string): void {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, '');
      this.pending = this.pending.slice(end + 1);
      this.accept(line, true);
    }
  }
  finish(): void {
    if (this.pending) this.accept(this.pending.replace(/\r$/, ''), false);
    this.flushTable(false);
    this.flushCandidate();
    this.pending = '';
    this.fence = undefined;
    this.written = false;
  }
  private emit(text: string): void {
    if (text) this.written = true;
    this.write(text);
  }
  private flushCandidate(): void {
    if (!this.candidate) return;
    const { text, newline } = this.candidate;
    this.candidate = undefined;
    this.emit(this.line(text) + (newline ? '\n' : ''));
  }
  private flushTable(newline: boolean): void {
    if (!this.table) return;
    const lines = this.table;
    this.table = undefined;
    const tokens = marked.lexer(lines.join('\n') + '\n', { gfm: true });
    const token = tokens[0];
    if (token?.type !== 'table') {
      this.emit(lines.map((line) => this.line(line)).join('\n') + (newline ? '\n' : ''));
      return;
    }
    const requested = typeof this.columns === 'function' ? this.columns() : this.columns;
    const columns = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 80;
    // The caller may have printed an assistant role prefix before this first
    // block. Start the table on its own line so all borders share an origin.
    this.emit(
      (this.written ? '' : '\n') +
        renderTable(token as Tokens.Table, this.color, columns) +
        (newline || tokens.length > 1 ? '\n' : ''),
    );
    // GFM block constructs (for example HTML containing a pipe) may end the
    // table before our line lookahead does. Preserve every remaining block.
    const remainder = tokens
      .slice(1)
      .map((item) => item.raw)
      .join('');
    if (remainder) {
      const text = remainder.replace(/\n$/, '');
      this.emit(
        text
          .split('\n')
          .map((line) => this.line(line))
          .join('\n') + (newline ? '\n' : ''),
      );
    }
  }
  private accept(raw: string, newline: boolean): void {
    const text = safeTerminalText(raw);
    if (this.table) {
      if (
        text.trim() &&
        text.includes('|') &&
        !/^\s{0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|`{3,}|~{3,})/.test(text)
      ) {
        if (this.table.length >= 256) {
          const header = this.table.slice(0, 2);
          this.flushTable(true);
          this.table = header;
        }
        this.table.push(text);
        return;
      }
      this.flushTable(true);
    }
    if (this.candidate) {
      if (
        /^[\s|:\-]+$/.test(text) &&
        text.includes('-') &&
        marked.lexer(`${this.candidate.text}\n${text}\n`, { gfm: true })[0]?.type === 'table'
      ) {
        this.table = [this.candidate.text, text];
        this.candidate = undefined;
        return;
      }
      this.flushCandidate();
    }
    if (
      !this.fence &&
      text.includes('|') &&
      !/^\s{0,3}(`{3,}|~{3,})/.test(text) &&
      !/^ {4}/.test(text)
    )
      this.candidate = { text, newline };
    else this.emit(this.line(text) + (newline ? '\n' : ''));
  }
  private line(raw: string): string {
    const text = safeTerminalText(raw);
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (this.fence) {
      if (
        fence &&
        fence[1][0] === this.fence.character &&
        fence[1].length >= this.fence.length &&
        !fence[2].trim()
      ) {
        this.fence = undefined;
        return '';
      }
      return this.color ? `\x1b[90m${text}\x1b[0m` : text;
    }
    if (fence) {
      this.fence = { character: fence[1][0], length: fence[1].length };
      return fence[2].trim() ? `[${fence[2].trim()}]` : '[code]';
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(text);
    if (heading) {
      const value = inline(marked.Lexer.lexInline(heading[1]), this.color);
      return this.color ? `\x1b[1m${value}\x1b[0m` : value;
    }
    if (/^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/.test(text))
      return '────────────────';
    const normalized = text
      .replace(/^(\s*)[-+*]\s+/, '$1• ')
      .replace(/^(\s*)>\s?/, '$1│ ')
      .replace(/\[ \]/g, '☐')
      .replace(/\[[xX]\]/g, '☑');
    return inline(marked.Lexer.lexInline(normalized), this.color);
  }
}
