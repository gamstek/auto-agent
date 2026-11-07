import { copyFile, mkdir, rm, stat, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { pnpmCommand } from '../../scripts/shared/pnpm';
import { startProcess } from '../../scripts/shared/process';

const root = resolve(import.meta.dirname, '../..');
if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64')
  throw new Error('Prepare the desktop runtime natively on Windows or Linux x64');
if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 24)
  throw new Error('Prepare the desktop runtime with Node.js 24+');
const output = join(root, 'desktop/src-tauri/runtime');

async function pnpm(args: string[]) {
  const [command, ...parameters] = pnpmCommand(args);
  if (await startProcess(command, parameters, { cwd: root, stdio: 'inherit' }).exited)
    throw new Error(`Runtime preparation failed: pnpm ${args.join(' ')}`);
}

await pnpm(['--workspace-root', 'run', 'build']);
await rm(output, { recursive: true, force: true });
await mkdir(dirname(output), { recursive: true });
// Deploy the registry CLI and its production dependencies. No private user configuration
// or credentials are copied: corax/package.json files is the application allowlist.
// Use pnpm's frozen shared-lockfile deployment with ordinary package directories.
// NSIS does not preserve the junctions in an isolated node_modules layout.
await pnpm(['--filter', 'auto-agent', 'deploy', '--prod', '--config.node-linker=hoisted', output]);
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
  'node_modules/shelljs/package.json',
  'sandbox.ts',
  'memory.ts',
]) {
  if (!(await stat(join(output, path))).isFile())
    throw new Error(`Runtime resource missing: ${path}`);
}
const deployed = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'));
if (deployed.name !== 'auto-agent')
  throw new Error('Packaged runtime must preserve the auto-agent session identity');
if (!deployed.dependencies?.['@coraxjs/core'])
  throw new Error('Packaged runtime is missing its registry Corax dependency');
if (!deployed.dependencies?.['@auto-agent/climber-mcp'])
  throw new Error('Packaged runtime is missing its Climber MCP dependency');
const prepared = JSON.parse(
  await readFile(join(output, '.output/.corax/compile/sandbox-prepared-artifacts.json'), 'utf8'),
);
if (
  !prepared.entries?.length ||
  prepared.entries.some((entry: { providerName: string }) => entry.providerName !== 'host')
)
  throw new Error(
    'Packaged runtime must select the ShellJS host sandbox, not a virtual sandbox template',
  );
let sourceMapBytes = 0;
async function preparePublishedTree(directory: string, dependencyArtifacts = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Runtime must not contain links: ${path}`);
    if (entry.isDirectory())
      await preparePublishedTree(
        path,
        dependencyArtifacts || entry.name === 'node_modules' || entry.name === '.output',
      );
    else if (dependencyArtifacts && entry.isFile() && entry.name.endsWith('.map')) {
      sourceMapBytes += (await stat(path)).size;
      await rm(path);
    }
  }
}
// Dependency source maps are debugging artifacts, not runtime inputs. Keep package
// sources, declarations, licenses and native/WASM assets intact.
await preparePublishedTree(output);
// Retire the previous generated resource directory after a successful deployment.
await rm(join(root, 'desktop/src-tauri/backend'), { recursive: true, force: true });
console.log(`Removed ${(sourceMapBytes / 1048576).toFixed(2)} MiB of dependency source maps`);
console.log(`Node desktop runtime ready: ${output}`);
