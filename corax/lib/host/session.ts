import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { SandboxSession, SandboxProcess } from '@coraxjs/core/sandbox';
import { hostPath, hostEnvironmentValue, type HostPaths } from './paths';
import { bindHostPaths, hostShell, hostEnvironment } from './shell';

export async function createHostSession(paths: HostPaths) {
  await mkdir(paths.workspace, { recursive: true });
  const processes = new Set<SandboxProcess>();
  const session: SandboxSession = {
    resolvePath: (path) => hostPath(path, paths),
    async spawn(options) {
      options.abortSignal?.throwIfAborted();
      const windows = process.platform === 'win32';
      const shell = hostShell(paths.project);
      const child = spawn(
        shell.executable,
        [...shell.args, bindHostPaths(options.command, paths)],
        {
          cwd: options.workingDirectory
            ? hostPath(options.workingDirectory, paths)
            : paths.workspace,
          env: hostEnvironment(shell.path, options.env),
          windowsHide: true,
          detached: !windows,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stopped = false;
      const kill = async () => {
        if (stopped || child.exitCode !== null || !child.pid) return;
        stopped = true;
        if (windows) {
          await new Promise<void>((resolve) => {
            const task = spawn(
              join(hostEnvironmentValue('SystemRoot') ?? 'C:/Windows', 'System32/taskkill.exe'),
              ['/PID', String(child.pid), '/T', '/F'],
              { windowsHide: true, stdio: 'ignore', env: hostEnvironment(shell.path) },
            );
            task.once('error', () => resolve());
            task.once('exit', () => resolve());
          });
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      };
      const abort = () => {
        void kill();
      };
      options.abortSignal?.addEventListener('abort', abort, { once: true });
      const exited = new Promise<{ exitCode: number }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
          options.abortSignal?.removeEventListener('abort', abort);
          processes.delete(handle);
          if (options.abortSignal?.aborted) reject(options.abortSignal.reason);
          else resolve({ exitCode: code ?? 1 });
        });
      });
      void exited.catch(() => {});
      const handle: SandboxProcess = {
        pid: child.pid,
        // Node's Web Streams and the Bun test ambient types disagree on BYOB overloads.
        stdout: Readable.toWeb(child.stdout!) as unknown as SandboxProcess['stdout'],
        stderr: Readable.toWeb(child.stderr!) as unknown as SandboxProcess['stderr'],
        wait: () => exited,
        kill,
      };
      processes.add(handle);
      if (options.abortSignal?.aborted) await kill();
      return handle;
    },
    async run(options) {
      const task = await session.spawn(options);
      const collect = async (stream: ReadableStream<Uint8Array>) => {
        const chunks: Uint8Array[] = [];
        for await (const bytes of stream) chunks.push(bytes);
        return Buffer.concat(chunks).toString('utf8');
      };
      const [result, stdout, stderr] = await Promise.all([
        task.wait(),
        collect(task.stdout),
        collect(task.stderr),
      ]);
      return { ...result, stdout, stderr };
    },
    async readBinaryFile(options) {
      options.abortSignal?.throwIfAborted();
      try {
        return await readFile(hostPath(options.path, paths), { signal: options.abortSignal });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async readFile(options) {
      const bytes = await session.readBinaryFile(options);
      return bytes === null
        ? null
        : new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
    },
    async readTextFile(options) {
      const bytes = await session.readBinaryFile(options);
      if (bytes === null) return null;
      const text =
        !options.encoding || options.encoding === 'utf-8'
          ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          : Buffer.from(bytes).toString(options.encoding as BufferEncoding);
      return text
        .split('\n')
        .slice((options.startLine ?? 1) - 1, options.endLine)
        .join('\n');
    },
    async writeBinaryFile(options) {
      options.abortSignal?.throwIfAborted();
      const path = hostPath(options.path, paths);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, options.content, { signal: options.abortSignal });
    },
    async writeTextFile(options) {
      await session.writeBinaryFile({
        ...options,
        content: Buffer.from(options.content, (options.encoding ?? 'utf8') as BufferEncoding),
      });
    },
    async writeFile(options) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of options.content) {
        options.abortSignal?.throwIfAborted();
        chunks.push(chunk);
      }
      await session.writeBinaryFile({ ...options, content: Buffer.concat(chunks) });
    },
    async removePath(options) {
      options.abortSignal?.throwIfAborted();
      await rm(hostPath(options.path, paths), {
        recursive: options.recursive,
        force: options.force,
      });
    },
  };
  return {
    sandbox: session,
    async close() {
      await Promise.all(
        [...processes].map(async (task) => {
          await task.kill();
          await Promise.resolve(task.wait()).catch(() => {});
        }),
      );
      processes.clear();
    },
  };
}
