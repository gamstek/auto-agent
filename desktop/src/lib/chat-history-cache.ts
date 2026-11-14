import type { ChatSnapshot } from '@auto-agent/desktop-protocol';
import type { CoraxProjection } from './corax-projection';

export type CachedChatHistory = {
  generation: string;
  snapshot: ChatSnapshot;
} & (
  | { projection: CoraxProjection; preview?: never }
  | { projection?: never; preview: { startIndex: number; kind: 'turns' | 'reply' } }
);

// Charge UTF-16 strings, property slots and object overhead, counting shared objects once.
// This is a conservative retention budget, not an engine-specific heap measurement.
function retainedBytes(value: unknown, limit: number): number {
  const seen = new WeakSet<object>();
  let bytes = 0;
  function visit(value: unknown, depth: number) {
    if (bytes > limit) return;
    if (typeof value === 'string') bytes += 16 + value.length * 2;
    else if (value && typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
      if (depth > 128) {
        bytes = Infinity;
        return;
      }
      bytes += 64;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        bytes += 48 + key.length * 2;
        visit((value as Record<string, unknown>)[key], depth + 1);
        if (bytes > limit) break;
      }
    } else bytes += 16;
  }
  visit(value, 0);
  return bytes;
}

/** Inactive display projections only. Taking an entry transfers ownership to the selected view. */
export class ChatHistoryCache {
  private entries = new Map<string, { history: CachedChatHistory; bytes: number }>();
  private bytes = 0;

  constructor(
    readonly maxSessions = 16,
    readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  get size() {
    return this.entries.size;
  }

  get estimatedBytes() {
    return this.bytes;
  }

  take(id: string): CachedChatHistory | undefined {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.bytes -= entry.bytes;
    return entry.history;
  }

  put(projection: CoraxProjection, generation: string) {
    this.retain(projection.id, { projection, generation, snapshot: projection.snapshot() });
  }

  /** A suffix is display-only: never retain it as an authoritative event prefix. */
  putPreview(
    snapshot: ChatSnapshot,
    generation: string,
    startIndex: number,
    kind: 'turns' | 'reply',
  ) {
    this.retain(snapshot.sessionId, { snapshot, generation, preview: { startIndex, kind } });
  }

  private retain(id: string, history: CachedChatHistory) {
    this.take(id);
    if (!id || !history.generation || this.maxSessions <= 0) return;
    const bytes = retainedBytes(history, this.maxBytes);
    // An oversized conversation remains readable in the active view, but is never retained.
    if (bytes > this.maxBytes) return;
    while (this.entries.size >= this.maxSessions || this.bytes + bytes > this.maxBytes)
      this.take(this.entries.keys().next().value!);
    this.entries.set(id, { history, bytes });
    this.bytes += bytes;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
