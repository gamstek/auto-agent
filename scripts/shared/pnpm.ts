/** Reuse the invoking workspace package manager without shell quoting, including on Windows. */
export function pnpmCommand(args: string[]): string[] {
  const manager = process.env.npm_execpath;
  if (!manager || !process.env.npm_config_user_agent?.startsWith('pnpm/'))
    throw new Error('Run this workspace task with pnpm run');
  const launcher = /\.(?:c?js|mjs)$/i.test(manager)
    ? [process.env.npm_node_execpath ?? 'node', manager]
    : [manager];
  return [...launcher, ...args];
}
