import { readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Remove deployment-only artifacts while keeping published resources link-free. */
export async function preparePublishedTree(root: string): Promise<number> {
  let sourceMapBytes = 0;
  async function visit(directory: string, dependencyArtifacts: boolean) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Runtime must not contain links: ${path}`);
      if (entry.isDirectory()) {
        // pnpm creates POSIX symlinks here (Windows uses command shims). The
        // runtime invokes fixed Node entry points, never these PATH launchers.
        // Remove the directory itself without following any links inside it.
        if (entry.name === '.bin' && basename(directory) === 'node_modules') {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        await visit(
          path,
          dependencyArtifacts || entry.name === 'node_modules' || entry.name === '.output',
        );
      } else if (dependencyArtifacts && entry.isFile() && entry.name.endsWith('.map')) {
        sourceMapBytes += (await stat(path)).size;
        await rm(path);
      }
    }
  }
  await visit(root, false);
  return sourceMapBytes;
}
