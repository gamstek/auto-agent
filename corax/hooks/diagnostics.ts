import { defineHook } from '@coraxjs/core/hooks';
import { appendFileSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { coraxDataDirectory, getRuntimeConfig } from '../lib/config';

// Observe durable failures at the producer, including sessions with no open view.
function record(event: {
  type: 'turn.failed' | 'session.failed';
  meta: { at: string };
  data: { code: string; details?: Record<string, unknown>; message: string };
}) {
  try {
    const timestampMs = Date.parse(event.meta.at);
    if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) return;
    const { code, details, message } = event.data;
    const errorCode = ['MODEL_CALL_FAILED', 'WORKFLOW_STREAM_WRITE_FAILED'].includes(code)
      ? code
      : 'OTHER';
    // A parked model rejection has a plain Error with our own status prefix;
    // other native model failures carry structured status metadata.
    const status =
      details?.upstreamStatusCode ??
      details?.statusCode ??
      Number(/^模型调用失败（HTTP (\d{3})）：/.exec(message)?.[1]);
    const httpStatus =
      code === 'MODEL_CALL_FAILED' &&
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599
        ? status
        : undefined;
    const directory = join(coraxDataDirectory(getRuntimeConfig().dataDir), 'logs');
    for (let p = directory; ; p = dirname(p)) {
      const info = lstatSync(p, { throwIfNoEntry: false });
      if (info && !info.isDirectory()) return;
      if (p === dirname(p)) break;
    }
    mkdirSync(directory, { recursive: true });
    const file = join(directory, 'runtime-failures.log');
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (info && (!info.isFile() || info.nlink !== 1)) return;
    if (info && info.size >= 256 * 1024)
      renameSync(file, join(directory, 'runtime-failures.previous.log'));
    appendFileSync(
      file,
      JSON.stringify({ event: event.type, timestampMs, errorCode, httpStatus }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // A read-only or unavailable diagnostics directory must not affect settlement.
  }
}

export default defineHook({ events: { 'turn.failed': record, 'session.failed': record } });
