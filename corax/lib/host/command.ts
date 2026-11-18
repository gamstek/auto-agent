import { createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SandboxSession, SandboxSpawnOptions } from '@coraxjs/core/sandbox';
import { toShellPath } from './paths';

type HostCommand = Awaited<ReturnType<NonNullable<SandboxSession['startCommand']>>>;

/** Stream process output to real files; Corax decides when the tool yields. */
export async function startHostCommand(
  session: SandboxSession,
  options: SandboxSpawnOptions,
  pending: Set<Promise<unknown>>,
): Promise<HostCommand> {
  options.abortSignal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'auto-agent-command-'));
  let child;
  try {
    child = await session.spawn(options);
    if (!child.pid) throw new Error('宿主命令未返回进程标识');
    await writeFile(join(directory, 'pid'), String(child.pid));
  } catch (error) {
    await child?.kill();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const process = child;
  const stopOnFailure = async (error: unknown): Promise<never> => {
    await process.kill();
    throw error;
  };
  const capture = (name: string, stream: ReadableStream<Uint8Array>) =>
    pipeline(
      Readable.fromWeb(stream as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(join(directory, name)),
    ).catch(stopOnFailure);
  const finished = (async () => {
    const results = await Promise.allSettled([
      process.wait(),
      capture('stdout', process.stdout),
      capture('stderr', process.stderr),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    const result = results[0];
    if (result.status !== 'fulfilled') throw new Error('无法确认宿主命令退出状态');
    await writeFile(join(directory, 'exit'), String(result.value.exitCode));
    return result.value;
  })();
  pending.add(finished);
  void finished.finally(() => pending.delete(finished)).catch(() => {});
  return {
    pid: child.pid!,
    outputDirectory: toShellPath(directory),
    stopCommand:
      globalThis.process.platform === 'win32'
        ? `taskkill.exe /PID ${child.pid} /T /F`
        : `kill -- -${child.pid}`,
    wait: () => finished,
    kill: async () => {
      await process.kill();
    },
    async readOutput(maxBytes) {
      const [stdout, stderr] = await Promise.all([
        readTail(join(directory, 'stdout'), maxBytes),
        readTail(join(directory, 'stderr'), maxBytes),
      ]);
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        omittedBytes: { stdout: stdout.omitted, stderr: stderr.omitted },
      };
    },
    async cleanup() {
      await finished.catch(() => {});
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function readTail(path: string, maxBytes: number) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const length = Math.min(size, Math.max(1, Math.floor(maxBytes)));
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await file.read(bytes, 0, length, size - length);
    return { text: bytes.subarray(0, bytesRead).toString('utf8'), omitted: size - length };
  } finally {
    await file.close();
  }
}
