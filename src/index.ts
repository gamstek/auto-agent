import { dispatchInternalRuntime } from './execution/runtime';

try {
  if (!(await dispatchInternalRuntime())) {
    const { main } = await import('./app');
    await main();
  }
} catch (error) {
  const { errorText } = await import('./shared/types');
  const { output } = await import('./shared/console');
  output.error(errorText(error));
  process.exitCode = 1;
}
