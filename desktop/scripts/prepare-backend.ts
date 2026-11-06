import { copyFile, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { pnpmCommand } from '../../scripts/shared/pnpm';
import { startProcess } from '../../scripts/shared/process';

const root = resolve(import.meta.dirname, '../..');
if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64')
  throw new Error('Prepare the desktop backend natively on Windows or Linux x64');
if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 24)
  throw new Error('Prepare the desktop backend with Node.js 24+');
const output = join(root, 'desktop/src-tauri/backend');

async function pnpm(args: string[]) {
  const [command, ...parameters] = pnpmCommand(args);
  if (await startProcess(command, parameters, { cwd: root, stdio: 'inherit' }).exited)
    throw new Error(`Backend preparation failed: pnpm ${args.join(' ')}`);
}

await pnpm(['--workspace-root', 'run', 'build']);
await rm(output, { recursive: true, force: true });
await mkdir(dirname(output), { recursive: true });
// Deploy the registry CLI and its production dependencies. No private user configuration
// or credentials are copied: package.json files is the application resource allowlist.
// NSIS uses MAX_PATH when opening resources. Shorten peer-qualified store names
// in this deployment while retaining pnpm's shared-lockfile dependency layout.
await pnpm([
  '--filter',
  'auto-agent',
  'deploy',
  '--prod',
  '--legacy',
  '--config.virtual-store-dir-max-length=24',
  output,
]);
await build({
  entryPoints: [join(root, 'desktop/src-tauri/installer/reset-data.ts')],
  outfile: join(output, 'install-reset.mjs'),
  platform: 'node',
  target: 'node24',
  format: 'esm',
  bundle: true,
});
await copyFile(process.execPath, join(output, process.platform === 'win32' ? 'node.exe' : 'node'));
const license = await fetch(
  `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
);
if (!license.ok) throw new Error('Could not retrieve the license for the bundled Node.js runtime');
await writeFile(join(output, 'NODE-LICENSE'), await license.text());
for (const path of [
  'install-reset.mjs',
  '.output/server/index.mjs',
  'skills/device-automation/assets/library.sqlite',
  'node_modules/@auto-agent/climber-mcp/src/cli.ts',
  'node_modules/@auto-agent/climber-mcp/src/sam/sam.js',
  'node_modules/@auto-agent/climber-mcp/src/sam/sam-write.js',
  'node_modules/@auto-agent/climber-mcp/src/sam/sam-generate.js',
  'node_modules/@auto-agent/climber-mcp/src/sam/sam-profiles.json',
  'node_modules/@coraxjs/core/bin/corax.js',
  'node_modules/tsx/package.json',
]) {
  if (!(await stat(join(output, path))).isFile())
    throw new Error(`Backend resource missing: ${path}`);
}
const deployed = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'));
if (!deployed.dependencies?.['@coraxjs/core'])
  throw new Error('Packaged backend is missing its registry Corax dependency');
if (!deployed.dependencies?.['@auto-agent/climber-mcp'])
  throw new Error('Packaged backend is missing its Climber MCP dependency');
console.log(`Node desktop backend ready: ${output}`);
