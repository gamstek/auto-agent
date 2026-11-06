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

/** Remove only obsolete application payloads, never configuration or user data. */
export async function removeLegacyResources(directory: string) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Installation directory must be a regular directory');
  for (const name of ['backend', 'auto-agent-backend.exe'])
    await rm(join(directory, name), { recursive: true, force: true });
}

if (process.argv[2] === '--install') {
  try {
    if (process.platform !== 'win32') throw new Error('Windows installer only');
    if (!process.argv[3]) throw new Error('Installation directory is required');
    await removeLegacyResources(process.argv[3]);
    await resetInstalledData(join(homedir(), '.auto-agent'));
  } catch {
    console.error(
      'Unable to complete installation. Close Auto-Agent and its CLI, then run installation again.',
    );
    process.exitCode = 1;
  }
}
