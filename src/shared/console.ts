import type { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

type Level = 'info' | 'warn' | 'error';
const colors: Record<Level, number> = { info: 90, warn: 33, error: 31 };

export function supportsColor(stream: Writable): boolean {
  return (
    Boolean((stream as NodeJS.WriteStream).isTTY) &&
    process.env.NO_COLOR === undefined &&
    process.env.TERM !== 'dumb'
  );
}

export class ConsoleOutput {
  constructor(
    private readonly stdout: Writable = process.stdout,
    private readonly stderr: Writable = process.stderr,
    private readonly color?: boolean,
  ) {}

  text(message: string): void {
    this.stdout.write(this.safe(message) + '\n');
  }

  json(value: unknown): void {
    this.stdout.write(JSON.stringify(value) + '\n');
  }

  info(message: string): void {
    this.log(message, 'info');
  }

  warn(message: string): void {
    this.log(message, 'warn');
  }

  error(message: string): void {
    this.log(message, 'error');
  }

  diagnostic(message: string, level: Level = 'info'): void {
    const text = this.safe(message);
    const color = this.color ?? supportsColor(this.stderr);
    this.stderr.write(color ? `\x1b[${colors[level]}m${text}\x1b[0m\n` : text + '\n');
  }

  private log(message: string, level: Level): void {
    for (const line of message.split('\n')) this.diagnostic(`[${level}] ${line}`, level);
  }

  private safe(message: string): string {
    return stripVTControlCharacters(message).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }
}

export const output = new ConsoleOutput();
