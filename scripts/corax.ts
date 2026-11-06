import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig,
  defaultConfigPath,
  developmentConfigPath,
  ensureConfig,
  prepareCoraxData,
  ownCoraxRuntime,
} from '../lib/config';
import { startProcess } from './shared/process';

if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 24)
  throw new Error('Run Auto-Agent with Node.js 24+');
const root = resolve(import.meta.dirname, '..');
const command = process.argv[2] ?? 'dev';
if (!['dev', 'build', 'start'].includes(command)) throw new Error('Expected dev, build or start');
const args = process.argv.slice(3);
const env = {
  ...process.env,
  AUTO_AGENT_PROJECT_ROOT: root,
  AUTO_AGENT_CONFIG:
    process.env.AUTO_AGENT_CONFIG ??
    (command === 'dev' || command === 'build' ? developmentConfigPath(root) : defaultConfigPath()),
};
if (!process.env.AUTO_AGENT_CONFIG) ensureConfig(env.AUTO_AGENT_CONFIG);
const config = loadConfig(env.AUTO_AGENT_CONFIG);
const dataDirectory = prepareCoraxData(config.dataDir);
Object.assign(env, { CORAX_PROJECT_ROOT: root, CORAX_DATA_DIR: dataDirectory });
const releaseRuntime = command === 'build' ? () => {} : ownCoraxRuntime(dataDirectory);
let child: ReturnType<typeof startProcess> | undefined;
let interrupted = false;
async function run(action: 'dev' | 'build' | 'start', parameters: string[]) {
  if (interrupted) return 1;
  child = startProcess(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve('@coraxjs/core/bin')),
      action,
      ...(action === 'build' ? [] : ['--host', '127.0.0.1']),
      ...parameters,
    ],
    { cwd: root, env, stdio: 'inherit' },
  );
  return await child.exited;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    interrupted = true;
    child?.kill(signal);
  });
try {
  process.exitCode = await run(command as 'dev' | 'build' | 'start', args);
} finally {
  releaseRuntime();
}
