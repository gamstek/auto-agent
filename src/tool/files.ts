import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { AppError } from '../shared/types';

export interface FilePolicy {
  roots: string[];
  blocked: string[];
}
export interface FileMatch {
  path: string;
  line: number;
  text: string;
}
export interface FileSearchResult<T> {
  results: T[];
  truncated: boolean;
  skippedFiles: number;
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
};
const forbidden = (name: string) =>
  ['.git', '.auto-agent', 'node_modules'].includes(name.toLowerCase()) ||
  /^\.env(?:\.|$)/i.test(name);
const workerSource = `let regex;
self.onmessage = ({data}) => {
  try {
    if (data.pattern !== undefined) {
      regex = new RegExp(data.pattern, data.caseSensitive ? 'u' : 'iu');
      self.postMessage({ready:true}); return;
    }
    const matches = [];
    for (let i=0; i<data.lines.length; i++) {
      if (regex.test(data.lines[i])) {
        const chars = Array.from(data.lines[i]);
        matches.push({line:i+1,text:chars.slice(0,400).join(''),clipped:chars.length>400});
        if (matches.length >= data.limit) break;
      }
    }
    self.postMessage({matches});
  } catch { self.postMessage({error:true}); }
};`;

export class FileTools {
  constructor(
    readonly root: string,
    readonly bytes: number,
    readonly timeoutMs = 15000,
    readonly maxNodes = 10000,
  ) {}

  private check(signal: AbortSignal) {
    if (signal.aborted) throw new AppError('file_cancelled', 'File operation cancelled');
  }

  private async target(input: string, policy: FilePolicy) {
    if (!input || /\0/.test(input)) throw new AppError('file_path', 'Invalid file path');
    const path = resolve(this.root, input);
    if (policy.blocked.some((root) => inside(root, path)))
      throw new AppError('file_forbidden', 'Path is not available in this generation');
    const root = policy.roots
      .map((root) => resolve(root))
      .filter((root) => inside(root, path))
      .sort((a, b) => b.length - a.length)[0];
    if (!root)
      throw new AppError('file_forbidden', 'Path is outside the workspace and loaded skills');
    if (relative(root, path).split(sep).some(forbidden))
      throw new AppError(
        'file_forbidden',
        'Private configuration and dependency paths are not available',
      );
    try {
      await this.confined(root, path);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('file_unavailable', 'File path does not exist or cannot be read');
    }
    return { root, path };
  }

  private async confined(root: string, path: string) {
    let current = parse(root).root;
    for (const part of relative(current, root).split(sep).filter(Boolean)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new AppError('file_forbidden', 'Symbolic links are not permitted');
    }
    const canonical = await realpath(root);
    current = root;
    const parts = relative(root, path).split(sep).filter(Boolean);
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) current = join(current, parts[i]!);
      const stat = await lstat(current);
      if (
        stat.isSymbolicLink() ||
        relative(canonical, await realpath(current)) !== relative(root, current)
      )
        throw new AppError('file_forbidden', 'Path resolves outside its permitted root');
      if (i < parts.length - 1 && !stat.isDirectory())
        throw new AppError('file_path', 'Expected a directory');
    }
  }

  private async text(target: { root: string; path: string }, signal: AbortSignal) {
    this.check(signal);
    await this.confined(target.root, target.path);
    const before = await lstat(target.path);
    if (!before.isFile()) throw new AppError('file_path', 'Expected a regular file');
    if (before.size > this.bytes)
      throw new AppError(
        'file_limit',
        'File exceeds resourceLimitBytes; use a smaller file or increase the configured limit',
      );
    const handle = await open(target.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino)
        throw new AppError('file_changed', 'File changed while opening');
      const chunks: Buffer[] = [];
      let size = 0;
      while (size <= this.bytes) {
        this.check(signal);
        const buffer = Buffer.alloc(Math.min(4096, this.bytes + 1 - size));
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) break;
        size += bytesRead;
        chunks.push(buffer.subarray(0, bytesRead));
      }
      if (size > this.bytes) throw new AppError('file_limit', 'File exceeds resourceLimitBytes');
      await this.confined(target.root, target.path);
      const after = await lstat(target.path);
      if (after.dev !== stat.dev || after.ino !== stat.ino)
        throw new AppError('file_changed', 'File changed while reading');
      this.check(signal);
      const bytes = Buffer.concat(chunks);
      if (bytes.includes(0))
        throw new AppError('file_binary', 'Only UTF-8 text files are supported');
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new AppError('file_binary', 'Only UTF-8 text files are supported');
      }
    } finally {
      await handle.close();
    }
  }

  async read(path: string, policy: FilePolicy, signal: AbortSignal) {
    return this.bounded(signal, async (caller) =>
      this.text(await this.target(path, policy), caller),
    );
  }

  private async candidates(path: string, hidden: boolean, policy: FilePolicy, signal: AbortSignal) {
    const target = await this.target(path, policy);
    if ((await lstat(target.path)).isFile())
      return { target, files: [target.path], truncated: false };
    const files: string[] = [];
    const pending = [target.path];
    let visited = 0,
      truncated = false;
    while (pending.length) {
      this.check(signal);
      const directory = pending.shift()!;
      await this.confined(target.root, directory);
      const entries: { name: string; directory: boolean; file: boolean }[] = [];
      const handle = await opendir(directory);
      for await (const entry of handle) {
        this.check(signal);
        if (++visited > this.maxNodes) {
          truncated = true;
          break;
        }
        if (
          entry.isSymbolicLink() ||
          forbidden(entry.name) ||
          (!hidden && entry.name.startsWith('.'))
        )
          continue;
        const path = join(directory, entry.name);
        if (policy.blocked.some((root) => inside(root, path))) continue;
        entries.push({ name: entry.name, directory: entry.isDirectory(), file: entry.isFile() });
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.directory) {
          if (relative(target.path, path).split(sep).length <= 32) pending.push(path);
          else truncated = true;
        } else if (entry.file) files.push(path);
      }
      if (visited > this.maxNodes) break;
    }
    files.sort();
    return { target, files, truncated };
  }

  private async bounded<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>) {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    let abort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new AppError('file_cancelled', 'File operation cancelled'));
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
    });
    try {
      return await Promise.race([run(combined), cancelled]);
    } catch (error) {
      if (deadline.aborted && !signal.aborted)
        throw new AppError('file_timeout', 'File operation timed out; narrow the path or pattern');
      if (signal.aborted) throw new AppError('file_cancelled', 'File operation cancelled');
      if (error instanceof AppError) throw error;
      throw new AppError('file_unavailable', 'File search could not be completed');
    } finally {
      combined.removeEventListener('abort', abort);
    }
  }

  private fits(value: unknown) {
    return Buffer.byteLength(JSON.stringify(value)) <= this.bytes;
  }

  async glob(
    input: { pattern: string; path?: string; hidden?: boolean; limit: number },
    policy: FilePolicy,
    signal: AbortSignal,
  ) {
    return this.bounded(signal, async (caller) => {
      const candidates = await this.candidates(input.path ?? '.', !!input.hidden, policy, caller);
      let matcher: Bun.Glob;
      try {
        matcher = new Bun.Glob(input.pattern.replace(/\\/g, '/'));
      } catch {
        throw new AppError('file_pattern', 'Invalid glob pattern');
      }
      const result: FileSearchResult<string> = {
        results: [],
        truncated: candidates.truncated,
        skippedFiles: 0,
      };
      for (const path of candidates.files) {
        this.check(caller);
        const rel = relative(candidates.target.path, path).split(sep).join('/');
        if (!matcher.match(rel)) continue;
        if (
          result.results.length >= input.limit ||
          !this.fits({ ...result, results: [...result.results, path] })
        ) {
          result.truncated = true;
          break;
        }
        result.results.push(path);
      }
      if (!this.fits(result))
        throw new AppError(
          'file_output_limit',
          'resourceLimitBytes is too small for file search metadata',
        );
      return result;
    });
  }

  async grep(
    input: {
      pattern: string;
      path?: string;
      include?: string;
      literal?: boolean;
      caseSensitive?: boolean;
      limit: number;
    },
    policy: FilePolicy,
    signal: AbortSignal,
  ) {
    return this.bounded(signal, async (caller) => {
      this.check(caller);
      const worker = new Worker('data:text/javascript,' + encodeURIComponent(workerSource));
      const request = (data: unknown) =>
        new Promise<any>((resolve, reject) => {
          const abort = () => reject(new AppError('file_cancelled', 'File search cancelled'));
          const clear = () => caller.removeEventListener('abort', abort);
          worker.onmessage = (event) => {
            clear();
            event.data.error
              ? reject(new AppError('file_pattern', 'Invalid regular expression'))
              : resolve(event.data);
          };
          worker.onerror = () => {
            clear();
            reject(new AppError('file_pattern', 'Regular expression worker failed'));
          };
          caller.addEventListener('abort', abort, { once: true });
          if (caller.aborted) {
            clear();
            abort();
            return;
          }
          worker.postMessage(data);
        });
      try {
        const pattern = input.literal
          ? input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          : input.pattern;
        await request({ pattern, caseSensitive: input.caseSensitive !== false });
        const candidates = await this.candidates(input.path ?? '.', false, policy, caller);
        const include = input.include ? new Bun.Glob(input.include.replace(/\\/g, '/')) : undefined;
        const result: FileSearchResult<FileMatch> = {
          results: [],
          truncated: candidates.truncated,
          skippedFiles: 0,
        };
        for (const path of candidates.files) {
          this.check(caller);
          const rel = relative(candidates.target.path, path).split(sep).join('/');
          if (include && !include.match(rel) && !include.match(parse(path).base)) continue;
          let text: string;
          try {
            text = await this.text({ root: candidates.target.root, path }, caller);
          } catch (error) {
            if (
              error instanceof AppError &&
              ['file_limit', 'file_binary', 'file_changed', 'file_forbidden'].includes(error.code)
            ) {
              result.skippedFiles++;
              result.truncated = true;
              continue;
            }
            throw error;
          }
          const reply = await request({
            lines: text.split(/\r?\n/),
            limit: input.limit - result.results.length + 1,
          });
          for (const match of reply.matches as { line: number; text: string; clipped: boolean }[]) {
            const item = { path, line: match.line, text: match.text };
            if (
              result.results.length >= input.limit ||
              !this.fits({ ...result, results: [...result.results, item] })
            ) {
              result.truncated = true;
              return result;
            }
            if (match.clipped) result.truncated = true;
            result.results.push(item);
          }
        }
        if (!this.fits(result))
          throw new AppError(
            'file_output_limit',
            'resourceLimitBytes is too small for file search metadata',
          );
        return result;
      } finally {
        worker.terminate();
      }
    });
  }
}
