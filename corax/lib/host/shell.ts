import shell from 'shelljs';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, parse } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { hostPath, hostEnvironmentValue, toShellPath, type HostPaths } from './paths';

function which(command: string) {
  if (process.platform !== 'win32') return shell.which(command)?.toString();
  // Authored dev modules can receive a plain environment snapshot. Windows Path
  // remains case-insensitive even when that snapshot's JS keys are case-sensitive.
  for (const directory of (hostEnvironmentValue('PATH') ?? '').split(delimiter)) {
    if (!directory) continue;
    const path = join(directory.replace(/^"|"$/g, ''), `${command}.exe`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function hostBash() {
  const found = which('bash');
  const candidates =
    found && !/[/\\]Windows[/\\](System32|Sysnative)[/\\]bash\.exe$/i.test(found) ? [found] : [];
  const git = which('git');
  for (
    let directory = git ? dirname(git) : '';
    directory && directory !== parse(directory).root;
    directory = dirname(directory)
  ) {
    candidates.push(join(directory, 'bin/bash.exe'), join(directory, 'usr/bin/bash.exe'));
  }
  const executable = candidates.find((path) => existsSync(path));
  if (!executable)
    throw new Error(
      'ShellJS 未找到宿主机 Bash。Corax 原生工具需要 POSIX Shell；Windows 可使用已安装的 Git Bash，并将其加入 PATH。',
    );
  const directories = [dirname(executable)];
  for (
    let directory = dirname(executable);
    directory !== parse(directory).root;
    directory = dirname(directory)
  ) {
    const utilities = join(directory, 'usr/bin');
    if (existsSync(utilities)) {
      directories.push(utilities);
      break;
    }
  }
  return {
    executable,
    path: [...new Set(directories), hostEnvironmentValue('PATH') ?? ''].join(delimiter),
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
  // Application-private transport/model credentials are not host command credentials.
  for (const key of Object.keys(env))
    if (['AUTO_AGENT_TOKEN', 'AUTO_AGENT_API_KEY'].includes(key.toUpperCase())) delete env[key];
  return env;
}

function isResourceAlias(value: string) {
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
    /'([^']*)'|"([^"$`]*)"|(^|[\s;|&])((?:\/workspace|\/tmp)(?:\/[^\s;'"|&()]*)?)(?=$|[\s;|&])/g,
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

export const shelljs = shell;
