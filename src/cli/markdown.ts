import { marked, type Token } from 'marked';
import { stripVTControlCharacters } from 'node:util';
export function safeTerminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
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
      if ('tokens' in token && token.tokens) return inline(token.tokens, color);
      return 'text' in token ? token.text : token.raw;
    })
    .join('');
}
export class TerminalMarkdown {
  private pending = '';
  private fence: { character: string; length: number } | undefined;
  constructor(
    private write: (text: string) => void,
    private color: boolean,
  ) {}
  append(text: string): void {
    this.pending += text;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, '');
      this.pending = this.pending.slice(end + 1);
      this.write(this.line(line) + '\n');
    }
  }
  finish(): void {
    if (this.pending) this.write(this.line(this.pending));
    this.pending = '';
    this.fence = undefined;
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
    if (/^\s*\|?\s*:?-{3,}/.test(text) && /^[\s|:\-]+$/.test(text)) return '';
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
