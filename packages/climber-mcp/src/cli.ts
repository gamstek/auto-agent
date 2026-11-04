import { serveClimber } from './server';

try {
  await serveClimber();
} catch {
  console.error(
    'Climber MCP startup failed; check the connection and state directory configuration.',
  );
  process.exitCode = 1;
}
