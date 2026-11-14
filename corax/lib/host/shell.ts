import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { hostPath, hostEnvironmentValue, toShellPath, type HostPaths } from './paths';
import { hostRuntimeDirectory } from './runtime';

function which(command: string) {
  // Authored dev modules can receive a plain environment snapshot. Windows Path
  // remains case-insensitive even when that snapshot's JS keys are case-sensitive.
  for (const directory of (hostEnvironmentValue('PATH') ?? '').split(delimiter)) {
    if (!directory) continue;
    const path = join(
      directory.replace(/^"|"$/g, ''),
      process.platform === 'win32' ? `${command}.exe` : command,
    );
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function hostShell(project = resolve(import.meta.dirname, '../..')) {
  const windows = process.platform === 'win32';
  const executable = windows
    ? join(hostRuntimeDirectory(project), 'busybox.exe')
    : (which('bash') ?? '/bin/sh');
  if (!existsSync(executable))
    throw new Error(
      windows
        ? '应用缺少随附的宿主执行组件。开发环境请运行 pnpm prepare:host；安装版请重新安装应用，无需安装 Git Bash。'
        : '未找到宿主 POSIX Shell。',
    );
  return {
    executable,
    args: windows ? ['sh', '-c'] : ['-c'],
    path: windows
      ? [hostRuntimeDirectory(project), hostEnvironmentValue('PATH') ?? ''].join(delimiter)
      : (hostEnvironmentValue('PATH') ?? ''),
  };
}

export function hostEnvironment(path: string, extra?: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: path,
    HOME: toShellPath(hostEnvironmentValue('HOME') || homedir()),
    TMPDIR: toShellPath(tmpdir()),
    ...extra,
  };
  // Node picks one spelling of duplicate environment keys on Windows. Do not let
  // an inherited `Path` shadow the PATH chosen for this command.
  if (process.platform === 'win32')
    for (const key of Object.keys(env))
      if (key.toUpperCase() === 'PATH' && key !== 'PATH') delete env[key];
  // Application-private transport/model credentials are not host command credentials.
  for (const key of Object.keys(env))
    if (['AUTO_AGENT_TOKEN', 'AUTO_AGENT_API_KEY'].includes(key.toUpperCase())) delete env[key];
  return env;
}

function isResourceAlias(value: string) {
  if (process.platform === 'win32' && /^\/[a-z](?::)?(?:\/|$)/i.test(value)) return true;
  return [
    '/workspace',
    '/tmp',
    '$HOME/.agents/skills',
    `${toShellPath(hostEnvironmentValue('HOME') || homedir())}/.agents/skills`,
  ].some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}
const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

/** Adapt documented Corax filesystem path arguments, not shell programs or tool contracts. */
export function bindHostPaths(command: string, paths: HostPaths) {
  return command.replace(
    /'([^']*)'|"([^"$`]*)"|(^|[\s;|&])((?:\/workspace|\/tmp|\/[a-z]:?)(?:\/[^\s;'"|&()]*)?)(?=$|[\s;|&])/gi,
    (
      match,
      single: string | undefined,
      double: string | undefined,
      before: string | undefined,
      bare: string | undefined,
    ) => {
      const path = single ?? double ?? bare;
      return path && isResourceAlias(path)
        ? `${before ?? ''}${quote(toShellPath(hostPath(path, paths)))}`
        : match;
    },
  );
}
