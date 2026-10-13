import { spawn, type ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Reserved local CLI entrypoints; never routed through the server or agent tools. */
export const SCRIPT_FLAG = '--auto-agent-internal-script';
export const ANCHOR_FLAG = '--auto-agent-internal-anchor';

/** Self-spawn Bun in development and the embedded runtime in compiled executables. */
export function runtimeCommand(flag: string, args: string[] = []): [string, string[]] {
  const compiled = /(?:\$bunfs|~BUN)[\\/]/i.test(import.meta.path);
  return [
    process.execPath,
    [...(compiled ? [] : [resolve(import.meta.dir, '..', 'index.ts')]), flag, ...args],
  ];
}

async function runScript(args: string[]): Promise<void> {
  const [script, ...scriptArgs] = args;
  if (!script || !isAbsolute(script)) throw new Error('Internal script requires an absolute path');
  // The executor confines and revalidates this trusted file before self-spawning.
  process.argv = [process.execPath, script, ...scriptArgs];
  await import(pathToFileURL(script).href);
}

function runAnchor(): void {
  if (!process.send) throw new Error('Internal anchor requires a parent IPC channel');
  let child: ChildProcess | undefined;
  let launched = false;
  const leave = () => {
    child?.kill();
    process.exit(1);
  };
  // A live stdin pipe pins the anchor after script exit, until the tracker kills it.
  // EOF/disconnect also prevents an orphaned idle anchor when its parent disappears.
  process.stdin.resume();
  process.stdin.on('end', leave);
  process.on('disconnect', leave);
  process.on('message', (message: unknown) => {
    if (launched || !message || typeof message !== 'object') return;
    const options = message as { command?: unknown; args?: unknown; cwd?: unknown };
    if (
      typeof options.command !== 'string' ||
      typeof options.cwd !== 'string' ||
      !Array.isArray(options.args) ||
      options.args.some((arg) => typeof arg !== 'string')
    )
      return;
    launched = true;
    process.send?.({ launchReceived: true });
    child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 1, 2],
    });
    child.on('error', () => process.send?.({ exitCode: null }));
    child.on('exit', (exitCode) => process.send?.({ exitCode }));
  });
  process.send({ anchorReady: true });
}

export async function dispatchInternalRuntime(args = process.argv.slice(2)): Promise<boolean> {
  if (args[0] === SCRIPT_FLAG) {
    await runScript(args.slice(1));
    return true;
  }
  if (args[0] === ANCHOR_FLAG) {
    if (args.length !== 1) throw new Error('Internal anchor takes no arguments');
    runAnchor();
    return true;
  }
  return false;
}
