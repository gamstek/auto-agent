import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareMacosNode() {
  if (process.platform !== 'darwin') return;
  const architecture = { arm64: 'aarch64', x64: 'x86_64' }[process.arch as 'arm64' | 'x64'];
  if (!architecture) throw new Error('Unsupported macOS Node architecture');
  const directory = resolve(import.meta.dirname, '../src-tauri/binaries');
  const file = resolve(directory, `auto-agent-node-${architecture}-apple-darwin`);
  await mkdir(directory, { recursive: true });
  await copyFile(process.execPath, file);
  await chmod(file, 0o755);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareMacosNode();
}
