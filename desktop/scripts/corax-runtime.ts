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
    'dist/src/shared/host-paths.js',
  ])
    if (!(await stat(join(root, path))).isFile())
      throw new Error(`Corax runtime resource missing: ${path}`);
  for (const [path, marker] of [
    ['dist/src/shared/sandbox-session.d.ts', 'startCommand'],
    ['dist/src/shared/sandbox-provider.d.ts', 'Pure resource metadata'],
    ['dist/src/execution/sandbox/bash.js', 'runHostCommand'],
    ['dist/src/execution/catalog/skills.js', 'Resource directory:'],
    ['dist/src/execution/catalog/skills.js', 'implementation.paths?.skills'],
    ['dist/src/execution/sandbox/ripgrep-probe.js', 'session.paths?.workspace'],
  ])
    if (!(await readFile(join(root, path), 'utf8')).includes(marker))
      throw new Error(`Corax runtime is missing the native-host compatibility patch: ${path}`);
}
