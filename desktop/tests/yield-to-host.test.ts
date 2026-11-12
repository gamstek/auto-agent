import { expect, test } from 'bun:test';
import { yieldToHost } from '../src/lib/yield-to-host';

test('history yielding uses the native scheduler with its receiver intact', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
  let calls = 0;
  const scheduler = {
    async yield() {
      expect(this).toBe(scheduler);
      calls++;
    },
  };
  Object.defineProperty(globalThis, 'scheduler', { value: scheduler, configurable: true });
  try {
    await yieldToHost();
    expect(calls).toBe(1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'scheduler', descriptor);
    else Reflect.deleteProperty(globalThis, 'scheduler');
  }
});

test('the MessageChannel fallback yields a task without a nested timer chain', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'scheduler');
  Object.defineProperty(globalThis, 'scheduler', { value: undefined, configurable: true });
  try {
    let done = false;
    const pending = yieldToHost().then(() => {
      done = true;
    });
    expect(done).toBe(false);
    await pending;
    expect(done).toBe(true);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'scheduler', descriptor);
    else Reflect.deleteProperty(globalThis, 'scheduler');
  }
});
