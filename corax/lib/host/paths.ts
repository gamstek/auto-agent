import { homedir, tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export interface HostPaths {
  workspace: string;
  skills: string;
  project?: string;
}

export function hostEnvironmentValue(name: string): string | undefined {
  return (
    process.env[name] ??
    (process.platform === 'win32'
      ? Object.entries(process.env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1]
      : undefined)
  );
}

export function toShellPath(value: string): string {
  return value.replaceAll('\\', '/');
}

/** Corax resource aliases resolve to installed resources; other paths are native host paths. */
export function hostPath(value: string, paths: HostPaths): string {
  let path = value.replaceAll('\\', '/');
  for (const prefix of [
    '$HOME/.agents/skills',
    '/workspace/skills',
    '/corax/resources/skills',
    `${toShellPath(hostEnvironmentValue('HOME') || homedir())}/.agents/skills`,
  ])
    if (path === prefix || path.startsWith(`${prefix}/`))
      return resolve(paths.skills, `.${path.slice(prefix.length)}`);
  if (path === '/workspace' || path.startsWith('/workspace/'))
    return resolve(paths.workspace, `.${path.slice('/workspace'.length)}`);
  if (path === '/tmp' || path.startsWith('/tmp/'))
    return resolve(tmpdir(), `.${path.slice('/tmp'.length)}`);
  if (path === '$HOME' || path.startsWith('$HOME/'))
    path = homedir().replaceAll('\\', '/') + path.slice(5);
  if (path === '~' || path.startsWith('~/')) path = homedir().replaceAll('\\', '/') + path.slice(1);
  if (process.platform === 'win32' && /^\/[a-z]:\//i.test(path)) path = path.slice(1);
  if (process.platform === 'win32' && /^\/[a-z](?:\/|$)/i.test(path))
    path = `${path[1].toUpperCase()}:${path.slice(2) || '/'}`;
  return isAbsolute(path) ? resolve(path) : resolve(paths.workspace, path);
}
