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
      licenses: { type: 'boolean' },
      'wiki-update': { type: 'boolean' },
      'wiki-index': { type: 'boolean' },
      'no-token': { type: 'boolean' },
    },
  });
}
export const help = `Auto-Agent — local AI agent with trusted skills

Usage
  auto-agent [serve] [options]
  auto-agent [options] [message]

Commands
  serve              Start the HTTP service (bearer token required by default)
  No command         Start interactive chat; positional text is the first message

Options
  --config PATH      Load a JSON configuration file
  --session ID       Resume an existing chat session
  --json             Print chat history and replies as newline-delimited JSON
  --no-token         Disable HTTP authentication on loopback only
  --wiki-update      Explicitly compile built-in and external wiki sources using the cloud model, then exit
  --wiki-index       Explicitly index wikiIndexRoots as local source evidence without model calls, then exit
  --licenses         Show bundled third-party license notices
  --help             Show this help

Examples
  auto-agent
  auto-agent --config config.json "List available skills"
  auto-agent serve --no-token

Chat controls
  /exit              Quit
  Ctrl+C             Cancel the current reply, or exit when idle

Diagnostics and progress go to stderr; replies and JSON go to stdout.`;
export async function cli(
  args: ReturnType<typeof argumentsFor>,
  config: Config,
  local?: AgentService,
  io?: ReplIO,
): Promise<void> {
  await repl(args, config, local, io);
}
