import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_LAYOUT } from '../../../lib/config/paths';

/** Installer-only layout cutover. Tests supply an isolated directory, never the user profile. */
export async function resetInstalledData(directory: string) {
  const marker = join(directory, '.data-layout');
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Installation data directory must be a regular directory');
    let layout: string | undefined;
    try {
      layout = await readFile(marker, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (layout === DATA_LAYOUT) return 'preserved';
    // node:fs.rm does not follow nested symbolic links or Windows junctions.
    await rm(directory, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(directory, { recursive: true });
  await writeFile(marker, DATA_LAYOUT, { mode: 0o600 });
  return 'initialized';
}

if (process.argv[2] === '--install') {
  try {
    if (process.platform !== 'win32') throw new Error('Windows installer only');
    await resetInstalledData(join(homedir(), '.auto-agent'));
  } catch {
    console.error(
      'Unable to reset .auto-agent. Close Auto-Agent and its CLI, then run installation again.',
    );
    process.exitCode = 1;
  }
}
