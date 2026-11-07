import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/** Runtime layout only; Corax owns the data stored inside this directory. */
export function coraxDataDirectory(dataDir: string) {
  return join(dataDir, 'corax');
}

/** A process guard only; conversation/workflow state remains exclusively Corax-owned. */
export function ownCoraxRuntime(directory: string): () => void {
  const path = join(directory, '.auto-agent-host.lock');
  const token = crypto.randomUUID();
  const contents = JSON.stringify({ pid: process.pid, token });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, contents, { flag: 'wx', mode: 0o600 });
      const release = () => {
        try {
          if (readFileSync(path, 'utf8') === contents) unlinkSync(path);
        } catch {}
        process.off('exit', release);
      };
      process.once('exit', release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Serialize stale-lock recovery so competing starters cannot unlink a newly acquired lock.
      const recovery = path + '.recovery';
      writeFileSync(recovery, contents, { flag: 'wx', mode: 0o600 });
      try {
        if (!existsSync(path)) continue;
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error('Corax runtime lock is not a regular file');
        const previous = readFileSync(path, 'utf8');
        const owner = JSON.parse(previous) as { pid?: number };
        if (!Number.isInteger(owner.pid) || owner.pid! <= 0)
          throw new Error('Corax runtime lock is invalid');
        let alive = true;
        try {
          process.kill(owner.pid!, 0);
        } catch (failure) {
          alive = (failure as NodeJS.ErrnoException).code !== 'ESRCH';
        }
        if (alive) throw new Error('Another backend is using this Corax data directory');
        if (readFileSync(path, 'utf8') === previous) unlinkSync(path);
      } finally {
        unlinkSync(recovery);
      }
    }
  }
  throw new Error('Could not acquire the Corax runtime lock');
}

export function prepareCoraxData(dataDir: string): string {
  const target = coraxDataDirectory(dataDir);
  mkdirSync(target, { recursive: true });
  return target;
}
