type HostScheduler = { yield?: () => Promise<void> };

/** Timer chains are clamped (and may be throttled by WebView2). Yield a task instead. */
export function yieldToHost(): Promise<void> {
  const scheduler = (globalThis as typeof globalThis & { scheduler?: HostScheduler }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
