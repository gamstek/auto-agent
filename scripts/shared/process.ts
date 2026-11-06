import { spawn, type SpawnOptions } from 'node:child_process';

/** Shared CLI/build launcher; it owns no application configuration or agent resources. */
export function startProcess(command: string, args: string[], options: SpawnOptions = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  // Consumers can finish startup checks before waiting for termination.
  void exited.catch(() => {});
  return Object.assign(child, { exited });
}
