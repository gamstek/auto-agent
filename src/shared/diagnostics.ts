import {
  appendFileSync,
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  renameSync,
  unlinkSync,
  constants,
} from 'node:fs';
import { join } from 'node:path';
import { output } from './console';

const sensitive =
  /authorization|cookie|password|secret|credential|api[_-]?key|(?:^|[_-])(?:access[_-]?|refresh[_-]?|auth[_-]?|bearer[_-]?|api[_-]?)?token$/i;
const omitted = /^(args|arguments|input|payload|stdout|prompt|reasoning|delta|content|body)$/i;
export function sanitizeDiagnostic(
  value: unknown,
  secrets: readonly string[] = [],
  depth = 0,
): unknown {
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
    return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, 2000);
  }
  if (Array.isArray(value))
    return value.slice(0, 16).map((v) => sanitizeDiagnostic(v, secrets, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 48)
        .map(([key, item]) => [
          key,
          sensitive.test(key)
            ? '[redacted]'
            : omitted.test(key)
              ? '[omitted]'
              : sanitizeDiagnostic(item, secrets, depth + 1),
        ]),
    );
  return value === null || ['number', 'boolean'].includes(typeof value) ? value : String(value);
}

/** Local bounded diagnostics. Logging never changes an equipment/tool outcome. */
export class Diagnostics {
  readonly directory: string;
  private warned = false;
  constructor(
    dataDir: string,
    private secrets: readonly string[] = [],
    private maxBytes = 2 * 1024 * 1024,
    private backups = 3,
  ) {
    this.directory = join(dataDir, 'logs');
  }
  paths() {
    return {
      agent: join(this.directory, 'agent.jsonl'),
      skills: join(this.directory, 'skills.jsonl'),
    };
  }
  sanitize(value: unknown) {
    return sanitizeDiagnostic(value, this.secrets);
  }
  write(scope: 'agent' | 'skills', event: string, details: Record<string, unknown> = {}) {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const directory = lstatSync(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink())
        throw new Error('Diagnostic directory must be a regular directory');
      const file = this.paths()[scope];
      const safe = this.sanitize(details) as Record<string, unknown>;
      const safeEvent = this.sanitize(event) as string;
      const entry = { ...safe, timestamp: new Date().toISOString(), event: safeEvent };
      let line = JSON.stringify(entry);
      if (Buffer.byteLength(line) + 1 > Math.min(12000, this.maxBytes)) {
        const compact = {
          timestamp: entry.timestamp,
          event: safeEvent.slice(0, 64),
          truncated: true,
          runId: safe.runId,
          executionId: safe.executionId,
          preview: line.slice(0, 2000),
        };
        while (
          Buffer.byteLength(JSON.stringify(compact)) + 1 > this.maxBytes &&
          compact.preview.length
        )
          compact.preview = compact.preview.slice(0, Math.floor(compact.preview.length / 2));
        line = JSON.stringify(compact);
        if (Buffer.byteLength(line) + 1 > this.maxBytes) return;
      }
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error('Diagnostic log must be a regular file');
        if (stat.size + Buffer.byteLength(line) + 1 > this.maxBytes) {
          for (let index = this.backups; index >= 1; index--) {
            const from = index === 1 ? file : `${file}.${index - 1}`;
            const to = `${file}.${index}`;
            try {
              const old = lstatSync(to);
              if (!old.isFile() || old.isSymbolicLink())
                throw new Error('Diagnostic backup must be a regular file');
              unlinkSync(to);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            try {
              const old = lstatSync(from);
              if (!old.isFile() || old.isSymbolicLink())
                throw new Error('Diagnostic backup must be a regular file');
              renameSync(from, to);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const fd = openSync(
        file,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        appendFileSync(fd, line + '\n');
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // SQLite remains the authoritative execution audit even if log storage is unavailable.
      if (!this.warned) {
        this.warned = true;
        try {
          output.warn(
            `Diagnostic logging unavailable: ${String(this.sanitize(error instanceof Error ? error.message : error))}`,
          );
        } catch {
          /* Keep logging best-effort. */
        }
      }
    }
  }
}
