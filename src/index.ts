import { dispatchInternalRuntime } from './execution/runtime';

try {
  if (process.argv[2] === '--mcp-server') {
    if (process.argv.length !== 4) throw new Error('MCP server mode requires a program name');
    const { serveBundledMcp } = await import('./integrations/mcp-servers');
    await serveBundledMcp(process.argv[3]!);
  } else if (!(await dispatchInternalRuntime())) {
    const { main } = await import('./app');
    await main();
  }
} catch (error) {
  const { errorText } = await import('./shared/types');
  const { output } = await import('./shared/console');
  output.error(errorText(error));
  process.exitCode = 1;
}
