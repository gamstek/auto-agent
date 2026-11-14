import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Inspect the shipped registry artifact without importing private SDK APIs. */
export async function verifyCoraxRuntime(runtime: string) {
  const root = join(runtime, 'node_modules/@coraxjs/core');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.name !== '@coraxjs/core' || manifest.version !== '0.1.1')
    throw new Error('Runtime must include the published @coraxjs/core@0.1.1');
  const provenance = JSON.parse(
    await readFile(join(root, 'dist/src/compiled/@workflow/world-local/UPSTREAM.json'), 'utf8'),
  );
  if (
    provenance.repository !== 'vercel/workflow' ||
    provenance.commit !== 'c11fc40013681fef9afe0b315b1d22284579bbe0'
  )
    throw new Error('Runtime is missing the verified official SQLite Workflow World');
  for (const path of [
    'bin/corax.js',
    'dist/src/compiled/@workflow/world-local/index.js',
    'dist/src/compiled/@workflow/world-local/LICENSE',
    'dist/src/execution/history-read-scope.js',
    'dist/src/corax-channel/session-title.js',
  ])
    if (!(await stat(join(root, path))).isFile())
      throw new Error(`Corax runtime resource missing: ${path}`);
}
