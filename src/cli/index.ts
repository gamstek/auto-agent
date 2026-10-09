import { parseArgs } from 'node:util';
import type { AgentService } from '../agent';
import type { Config } from '../config';
import { repl, type ReplIO } from './repl';
export function argumentsFor(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      session: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
      'no-token': { type: 'boolean' },
    },
  });
}
export const help =
  'auto-agent [serve] [--config PATH] [--no-token] [--session ID] [--json]\nWithout serve: interactive REPL. Other positional arguments are the first chat message, not commands. REPL: /exit; Ctrl+C cancels generation or exits when idle.\nserve starts HTTP and requires a token unless --no-token is specified. REPL runs locally without authentication.';
export async function cli(
  args: ReturnType<typeof argumentsFor>,
  config: Config,
  local?: AgentService,
  io?: ReplIO,
): Promise<void> {
  await repl(args, config, local, io);
}
