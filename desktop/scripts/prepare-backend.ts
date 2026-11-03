import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '../..');
const windows = process.platform === 'win32';
if (!windows && process.platform !== 'linux')
  throw new Error('Desktop backend currently supports Windows and Linux x64');
const triple = windows ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
const directory = resolve(root, 'desktop/src-tauri/binaries');
await mkdir(directory, { recursive: true });
const target = resolve(directory, `auto-agent-backend-${triple}${windows ? '.exe' : ''}`);
const child = Bun.spawn(
  [process.execPath, resolve(root, 'scripts/build.ts'), windows ? 'windows' : 'linux', target],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' },
);
const code = await child.exited;
if (code !== 0) throw new Error('Public sidecar build failed');
console.log(`Desktop sidecar ready: ${target}`);
