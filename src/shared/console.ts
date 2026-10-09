import type { Writable } from 'node:stream';
export function warning(
  message: string,
  output: Writable = process.stdout,
  color = process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb',
): void {
  const text = `Warning: ${message}`;
  output.write(color ? `\x1b[33m${text}\x1b[0m\n` : text + '\n');
}
