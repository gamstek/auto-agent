import { ReplRenderer } from './renderer';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AgentService } from '../agent';
import type { Config } from '../config';
import { AppError, errorText, type Message } from '../shared/types';
import { ConsoleOutput, supportsColor } from '../shared/console';
import type { argumentsFor } from './index';
export interface ReplIO {
  input: Readable;
  output: Writable;
  error: Writable;
  terminal?: boolean;
  color?: boolean;
}
export async function repl(
  args: ReturnType<typeof argumentsFor>,
  config: Config,
  local?: AgentService,
  io: ReplIO = {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    terminal: process.stdin.isTTY && process.stdout.isTTY,
  },
): Promise<void> {
  if (!local) throw new AppError('usage', 'REPL requires a local Agent service.');
  const renderer = new ReplRenderer(
    io.output,
    io.error,
    !args.values.json && (io.color ?? (Boolean(io.terminal) && supportsColor(io.output))),
    !args.values.json && (io.color ?? supportsColor(io.error)),
  );
  const console = new ConsoleOutput(io.output, io.error);
  const sessionId = args.values.session ?? local.store.createSession().id;
  if (args.values.session) local.store.getSession(sessionId);
  const history: Message[] = args.values.session ? local.store.messages(sessionId) : [];
  renderer.line(`Session: ${sessionId}`);
  renderer.line('Type a message; /exit to quit. Ctrl+C cancels a reply, or exits when idle.');
  for (const message of history) {
    if (args.values.json) console.json(message);
    else renderer.history(message);
  }
  const terminal = Boolean(io.terminal) && !args.values.json;
  const readline = createInterface({
    input: io.input,
    output: io.output,
    terminal,
    crlfDelay: Infinity,
  });
  let busy = false;
  let cancelling = false;
  const interrupt = () => {
    if (!busy) {
      readline.close();
      return;
    }
    if (cancelling) return;
    cancelling = true;
    void local.abort(sessionId).catch((error) => renderer.failure(errorText(error)));
  };
  readline.on('SIGINT', interrupt);
  if (!terminal) process.on('SIGINT', interrupt);
  const send = async (content: string) => {
    if (!content.trim()) return;
    busy = true;
    cancelling = false;
    let streamed = false;
    const unsubscribe = local.events.subscribe((event) => {
      if (event.sessionId !== sessionId || args.values.json) return;
      if (event.type === 'message.part.delta') streamed = true;
      renderer.event(event);
    });
    try {
      const reply = await local.submit(sessionId, content);
      if (args.values.json) console.json(reply);
      else renderer.reply(reply, streamed);
    } catch (error) {
      renderer.failure(errorText(error));
    } finally {
      unsubscribe?.();
      busy = false;
      cancelling = false;
    }
  };
  try {
    // Start consuming immediately so piped input is buffered during generation.
    const lines = readline[Symbol.asyncIterator]();
    const initial = args.positionals.join(' ');
    if (initial.trim() === '/exit') return;
    if (initial) await send(initial);
    if (terminal) {
      readline.setPrompt(renderer.prompt());
      readline.prompt();
    }
    for await (const line of { [Symbol.asyncIterator]: () => lines }) {
      if (line.trim() === '/exit') break;
      await send(line);
      if (terminal) readline.prompt();
    }
  } finally {
    readline.removeListener('SIGINT', interrupt);
    process.removeListener('SIGINT', interrupt);
    readline.close();
  }
}
