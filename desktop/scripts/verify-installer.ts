import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startProcess } from '../../scripts/shared/process';

// Extract rather than execute NSIS: verification must never touch the developer's
// registry, installed application or ~/.auto-agent data-layout marker.
if (process.platform !== 'win32') throw new Error('Verify the Windows installer on Windows');
const root = resolve(import.meta.dirname, '../..');
const config = JSON.parse(await readFile(join(root, 'desktop/src-tauri/tauri.conf.json'), 'utf8'));
const installer = resolve(
  process.argv[2] ??
    join(
      root,
      'desktop/src-tauri/target/release/bundle/nsis',
      `Auto-Agent_${config.version}_x64-setup.exe`,
    ),
);
const sevenZip = join(process.env.ProgramFiles ?? 'C:/Program Files', '7-Zip/7z.exe');
const temporary = await mkdtemp(join(tmpdir(), 'auto-agent-installer-'));
try {
  const extracted = join(temporary, 'extracted');
  const extraction = startProcess(sevenZip, ['x', installer, `-o${extracted}`, '-y', '-bso0'], {
    stdio: 'inherit',
  });
  assert.equal(await extraction.exited, 0, 'Could not extract the NSIS payload with 7-Zip');
  const runtime = join(extracted, 'runtime');
  for (const resource of [
    'node.exe',
    'NODE-LICENSE',
    'install-reset.mjs',
    'node_modules/@coraxjs/core/package.json',
    'node_modules/@coraxjs/core/dist/src/compiled/@workflow/world-local/stream-info-batched.js',
    'node_modules/@coraxjs/core/dist/src/execution/history-read-scope.js',
    'node_modules/tsx/package.json',
    'node_modules/@auto-agent/climber-mcp/src/sam/sam-profiles.json',
    'skills/device-automation/assets/library.sqlite',
  ])
    assert.ok((await stat(join(runtime, resource))).isFile(), `Missing installed ${resource}`);
  for (const obsolete of ['backend', 'auto-agent-backend.exe', 'runtime/bun.exe'])
    await assert.rejects(stat(join(extracted, obsolete)), { code: 'ENOENT' });

  // Exercise the compiled installer helper on an isolated same-layout reinstall.
  // Import its functions without invoking the real --install entry point.
  const { removeLegacyResources, resetInstalledData } = await import(
    pathToFileURL(join(runtime, 'install-reset.mjs')).href
  );
  await mkdir(join(extracted, 'backend'));
  await writeFile(join(extracted, 'backend/bun.exe'), 'obsolete fixture');
  await writeFile(join(extracted, 'auto-agent-backend.exe'), 'obsolete fixture');
  const data = join(temporary, 'user-data');
  await resetInstalledData(data);
  await writeFile(join(data, 'conversations'), 'preserve current data');
  await removeLegacyResources(extracted);
  assert.equal(await resetInstalledData(data), 'preserved');
  assert.equal(await readFile(join(data, 'conversations'), 'utf8'), 'preserve current data');
  await assert.rejects(stat(join(extracted, 'backend')), { code: 'ENOENT' });
  await assert.rejects(stat(join(extracted, 'auto-agent-backend.exe')), { code: 'ENOENT' });

  // Exercise the actual Rust launcher with canonicalized Windows paths, the
  // bundled Node and inherited host environment (not just the test harness).
  const launcher = startProcess(
    'cargo',
    [
      'test',
      '--manifest-path',
      'desktop/src-tauri/Cargo.toml',
      '--locked',
      'corax::tests::node_launcher_accepts_canonical_windows_resource_paths',
    ],
    { cwd: root, env: { ...process.env, AUTO_AGENT_TEST_RUNTIME: runtime }, stdio: 'inherit' },
  );
  assert.equal(
    await launcher.exited,
    0,
    'Rust could not launch the bundled Node with Windows paths',
  );

  // The existing fake-model/vendor scenario relocates the extracted runtime again
  // and checks native Corax, Wiki, SAM and MCP without any live model or device.
  const verification = startProcess(
    'bun',
    ['test', 'tests/corax/runtime.test.ts', '-t', 'packaged'],
    {
      cwd: root,
      env: { ...process.env, AUTO_AGENT_TEST_RUNTIME: runtime },
      stdio: 'inherit',
    },
  );
  assert.equal(await verification.exited, 0, 'Extracted installer runtime failed verification');
  console.log(`Verified NSIS payload, legacy cleanup and native runtime: ${installer}`);
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
}
