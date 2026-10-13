import { spawn, type ChildProcess } from 'node:child_process';
import { extname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Config } from '../config';
import { AppError, type ScriptRequest, type ScriptResult } from '../shared/types';
import { Skills } from '../skill';
import { ANCHOR_FLAG, SCRIPT_FLAG, runtimeCommand } from './runtime';

interface Waiter {
  limit: number;
  signal: AbortSignal;
  resolve: (release: (() => void) | null) => void;
  abort: () => void;
}
const active = new Map<symbol, number>();
const queue: Waiter[] = [];
function pump(): void {
  while (queue.length) {
    const next = queue[0]!;
    if (active.size >= Math.min(next.limit, ...active.values())) return;
    queue.shift();
    next.signal.removeEventListener('abort', next.abort);
    const token = Symbol();
    active.set(token, next.limit);
    let released = false;
    next.resolve(() => {
      if (!released) {
        released = true;
        active.delete(token);
        pump();
      }
    });
  }
}
function acquire(limit: number, signal: AbortSignal): Promise<(() => void) | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiter: Waiter = {
      limit,
      signal,
      resolve,
      abort: () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        resolve(null);
        pump();
      },
    };
    signal.addEventListener('abort', waiter.abort, { once: true });
    queue.push(waiter);
    pump();
  });
}

// Only identities observed below this execution's anchor may be terminated.
// CreationDate protects against PID reuse; no process-name matching is used.
const trackerSource = `
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('TRACKER_START')
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ProcessSnapshot {
  const uint TH32CS_SNAPPROCESS = 2;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32 {
    public uint dwSize, cntUsage, th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static Dictionary<int, int> Parents() {
    var result = new Dictionary<int, int>();
    var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
      var entry = new PROCESSENTRY32();
      entry.dwSize = (uint)Marshal.SizeOf(entry);
      if (Process32FirstW(snapshot, ref entry)) do {
        result[(int)entry.th32ProcessID] = (int)entry.th32ParentProcessID;
        entry.dwSize = (uint)Marshal.SizeOf(entry);
      } while (Process32NextW(snapshot, ref entry));
      return result;
    } finally { CloseHandle(snapshot); }
  }
}
'@
[Console]::Error.WriteLine('TRACKER_TYPES_READY')
$rootId = [int]$env:AUTO_AGENT_ANCHOR_PID
if ($rootId -le 0) { throw 'Execution anchor identifier missing' }
$tracked = @{}
function ProcessById([int]$id) {
  try {
    $process = Get-Process -Id $id -ErrorAction Stop
    [PSCustomObject]@{ ProcessId = [int]$process.Id; CreationDate = [long]$process.StartTime.ToUniversalTime().Ticks }
  } catch { $null }
}
function Capture {
  $parents = [ProcessSnapshot]::Parents()
  do {
    $changed = $false
    foreach ($entry in $parents.GetEnumerator()) {
      $id = [int]$entry.Key
      $parentId = [int]$entry.Value
      if (-not $tracked.ContainsKey($id) -and $tracked.ContainsKey($parentId)) {
        $parent = ProcessById $parentId
        $item = ProcessById $id
        if ($parent -and $item -and $parent.CreationDate -eq $tracked[$parentId].CreationDate -and $item.CreationDate -ge $parent.CreationDate) {
          $tracked[$id] = $item
          $changed = $true
        }
      }
    }
  } while ($changed)
}
try {
  $root = ProcessById $rootId
  if (-not $root) { throw 'Execution anchor missing' }
  $tracked[$rootId] = $root
  [Console]::Out.WriteLine('TRACKED')
  $stop = [Console]::In.ReadLineAsync()
  while (-not $stop.IsCompleted) { Capture; Start-Sleep -Milliseconds 50 }
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    Capture
    $ids = @($tracked.Keys | Where-Object { $_ -ne $rootId }) + @($rootId)
    foreach ($id in $ids) {
      $current = ProcessById $id
      if ($current -and $current.CreationDate -eq $tracked[$id].CreationDate) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Milliseconds 50
    $alive = @()
    foreach ($id in $tracked.Keys) {
      $current = ProcessById $id
      if ($current -and $current.CreationDate -eq $tracked[$id].CreationDate) { $alive += $id }
    }
    if ($alive.Count -eq 0) { [Console]::Out.WriteLine('CLEAN'); exit 0 }
  }
  [Console]::Out.WriteLine('FAILED'); exit 1
} catch { [Console]::Out.WriteLine('FAILED'); exit 1 }
`;

/** Resource-limited trusted scripts. This is not an operating-system sandbox. */
export class ScriptExecutor {
  constructor(
    private readonly config: Config,
    private readonly skills: Skills,
  ) {}

  async execute(request: ScriptRequest, signal: AbortSignal): Promise<ScriptResult> {
    const empty = (status: ScriptResult['status']): ScriptResult => ({
      status,
      stdout: '',
      stderr: '',
      exitCode: null,
    });
    if (signal.aborted) return empty('cancelled');
    if (
      !request ||
      typeof request.skill !== 'string' ||
      typeof request.path !== 'string' ||
      (request.args !== undefined &&
        (!Array.isArray(request.args) ||
          request.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))))
    ) {
      throw new AppError('script_request', 'Invalid script request');
    }
    const release = await acquire(this.config.maxConcurrent, signal);
    if (!release) return empty('cancelled');
    try {
      const resolved = await this.skills.resolveScript(request.skill, request.path);
      const command = this.config.interpreters[extname(resolved.path).toLowerCase()];
      if (!command || /[\0\r\n]/.test(command))
        throw new AppError('script_interpreter', 'Script interpreter is not configured');
      const env = this.environment();
      if (signal.aborted) return empty('cancelled');
      // Revalidate after waiting for the global slot, immediately before spawning.
      await this.skills.resolveScript(request.skill, request.path);
      const scriptArgs = [resolved.path, ...(request.args ?? [])];
      // Only bare Node names get a pre-launch fallback; explicit executable paths stay external.
      // Never retry a script failure: trusted scripts may already have performed side effects.
      const bareNode = command === 'node' || command === 'node.exe';
      const node = bareNode
        ? Bun.which(command, { PATH: env.PATH ?? '', cwd: resolved.skill.directory })
        : null;
      const [executable, args] =
        command === 'builtin' || (bareNode && !node)
          ? runtimeCommand(SCRIPT_FLAG, scriptArgs)
          : [node ?? command, scriptArgs];
      return await this.run(executable, args, resolved.skill.directory, env, signal);
    } finally {
      release();
    }
  }

  private environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const forbidden =
      /(?:key|token|secret|password|credential|openai|anthropic|model|azure|cohere|gemini)/i;
    for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) {
      const inherited = Object.keys(process.env).find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase(),
      );
      if (inherited && process.env[inherited] !== undefined) env[key] = process.env[inherited];
    }
    for (const [key, value] of Object.entries(this.config.scriptEnv)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        forbidden.test(key) ||
        /^(?:PATH|SystemRoot|TEMP|TMP|TMPDIR|NODE_OPTIONS|BUN_OPTIONS|NODE_PATH|LD_.*|DYLD_.*|COMSPEC|PATHEXT|PSModulePath)$/i.test(
          key,
        ) ||
        value.includes('\0') ||
        (this.config.apiKey && value.includes(this.config.apiKey)) ||
        (this.config.token && value.includes(this.config.token))
      ) {
        throw new AppError('script_env', 'Unsafe script environment entry');
      }
      env[key] = value;
    }
    for (const key of Object.keys(env)) {
      const value = env[key]!;
      if (
        (this.config.apiKey && value.includes(this.config.apiKey)) ||
        (this.config.token && value.includes(this.config.token))
      )
        delete env[key];
    }
    return env;
  }

  private async run(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
  ): Promise<ScriptResult> {
    const windows = process.platform === 'win32';
    const [anchorCommand, anchorArgs] = runtimeCommand(ANCHOR_FLAG);
    const child = spawn(windows ? anchorCommand : command, windows ? anchorArgs : args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: !windows,
      stdio: windows ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    const started = Date.now();
    const stages: string[] = [];
    const record = (stage: string) => {
      if (stages.length < 16) stages.push(`${stage}@${Date.now() - started}ms`);
    };
    record('spawn');
    let status: ScriptResult['status'] | undefined;
    let stdout = '',
      stderr = '',
      used = 0;
    let exitCode: number | null = null;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const stop = (reason: ScriptResult['status']) => {
      if (!status) {
        status = reason;
        finish();
      }
    };
    const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const remaining = Math.max(0, this.config.outputLimitBytes - used);
      const accepted = chunk.subarray(0, remaining);
      used += accepted.length;
      const text = decoders[stream].write(accepted);
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (chunk.length > remaining) stop('output_limit');
    };
    child.stdout!.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr!.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('error', () => {
      record('anchor_error');
      stop('failed');
    });
    child.on('exit', (code) => {
      if (!windows) {
        exitCode = code;
        stop(code === 0 ? 'completed' : 'failed');
      } else if (!status) stop('unknown');
    });
    child.on('message', (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'anchorReady' in message &&
        (message as { anchorReady: unknown }).anchorReady === true
      )
        record('anchor_ready');
      if (
        message &&
        typeof message === 'object' &&
        'launchReceived' in message &&
        (message as { launchReceived: unknown }).launchReceived === true
      )
        record('launch_received');
      if (message && typeof message === 'object' && 'exitCode' in message) {
        record('script_exit');
        const code = (message as { exitCode: unknown }).exitCode;
        exitCode = typeof code === 'number' ? code : null;
        stop(code === 0 ? 'completed' : 'failed');
      }
    });
    const abort = () => stop('cancelled');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop('timeout'), this.config.scriptTimeoutMs);
    let tracker: ChildProcess | undefined;
    let trackerDone: Promise<boolean> | undefined;
    let tracked: Promise<boolean> | undefined;
    if (windows && child.pid) {
      tracker = spawn(
        join(
          env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', trackerSource],
        {
          env: { ...env, AUTO_AGENT_ANCHOR_PID: String(child.pid) },
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let trackerDiagnostics = '';
      tracker.stderr!.on('data', (chunk: Buffer) => {
        trackerDiagnostics = (trackerDiagnostics + chunk.toString()).slice(-4096);
        for (const stage of ['TRACKER_START', 'TRACKER_TYPES_READY']) {
          if (trackerDiagnostics.includes(stage) && !stages.some((item) => item.startsWith(stage)))
            record(stage);
        }
      });
      let ready!: (value: boolean) => void;
      tracked = new Promise((resolve) => {
        ready = resolve;
      });
      let output = '';
      tracker.stdout!.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        if (output.includes('TRACKED')) {
          if (!stages.some((item) => item.startsWith('tracker_ready'))) record('tracker_ready');
          ready(true);
        }
      });
      trackerDone = new Promise((resolve) => {
        tracker!.on('error', () => {
          record('tracker_error');
          ready(false);
          resolve(false);
        });
        tracker!.on('close', (code) => {
          record(`tracker_close_${code}`);
          ready(false);
          resolve(code === 0 && output.includes('CLEAN'));
        });
      });
      tracker.stdin!.on('error', () => stop('unknown'));
      const isReady = await Promise.race([tracked, done.then(() => false)]);
      if (isReady && !status) {
        record('launch_send');
        child.send({ command, args, cwd }, (error) => {
          record(error ? 'launch_send_error' : 'launch_sent');
          if (error) stop('failed');
        });
      } else if (!status) stop('unknown');
    }
    await done;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    let clean = true;
    if (windows) {
      if (tracker && trackerDone) {
        tracker.stdin!.end('STOP\n');
        clean = await this.bounded(trackerDone, 15000);
        if (!clean) {
          tracker.kill();
          child.kill();
        }
      } else clean = !child.pid;
    } else if (child.pid) {
      clean = await this.terminateGroup(child.pid);
    }
    // close waits for buffered output and pipes held by descendants, with a bound.
    if (child.exitCode === null && child.signalCode === null)
      await this.bounded(
        new Promise<boolean>((resolve) => child.once('close', () => resolve(true))),
        2000,
      );
    else await new Promise((resolve) => setImmediate(resolve));
    if (!clean) status = 'unknown';
    if (windows && (status === 'timeout' || status === 'unknown')) {
      const diagnostic = `\n[execution] ${stages.join(', ')}\n`;
      collect('stderr', Buffer.from(diagnostic));
    }
    return { status: status ?? 'unknown', stdout, stderr, exitCode };
  }

  private async bounded(promise: Promise<boolean>, milliseconds: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async terminateGroup(pid: number): Promise<boolean> {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        process.kill(-pid, 0);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
}
