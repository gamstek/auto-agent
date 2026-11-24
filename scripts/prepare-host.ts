import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOST_RUNTIME_SOURCE,
  HOST_RUNTIME_VERSION,
  hostRuntimeArtifact,
  hostRuntimeDirectory,
  hostSearchArtifact,
} from 'auto-agent/host-runtime';

/** Verify checked-in inputs and unpack the Windows search tool locally. */
export async function prepareHostRuntime(project: string) {
  if (process.platform !== 'win32') return;
  const directory = hostRuntimeDirectory(project);
  for (const [name, artifact] of [
    ['busybox.exe', hostRuntimeArtifact()],
    ['busybox-source.tgz', HOST_RUNTIME_SOURCE],
    ['ripgrep.zip', hostSearchArtifact()],
  ] as const) {
    const target = join(directory, name);
    const bytes = await readFile(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(
        `Missing local host runtime input: ${target}. Restore the pinned assets before building.`,
      );
    });
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
      throw new Error(`Host runtime checksum mismatch: ${name}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), 'auto-agent-host-tools-'));
  try {
    await promisify(execFile)(
      join(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe'),
      ['-xf', join(directory, 'ripgrep.zip'), '-C', temporary],
      { windowsHide: true },
    );
    const extracted = join(temporary, hostSearchArtifact().directory);
    await copyFile(join(extracted, 'rg.exe'), join(directory, 'rg.exe'));
    await copyFile(join(extracted, 'COPYING'), join(directory, 'RIPGREP-COPYING'));
    await copyFile(join(extracted, 'LICENSE-MIT'), join(directory, 'RIPGREP-LICENSE-MIT'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  await writeFile(
    join(directory, 'NOTICE.txt'),
    [
      `BusyBox-w32 ${HOST_RUNTIME_VERSION} (unmodified standalone executable)`,
      'Copyright: BusyBox contributors and Ron Yorston; license: GPL-2.0-only.',
      'Complete corresponding source, build files and LICENSE are in busybox-source.tgz.',
      'Upstream: https://frippery.org/busybox/ and https://github.com/rmyorston/busybox-w32',
      `Binary SHA256: ${hostRuntimeArtifact().sha256}`,
      `Source SHA256: ${HOST_RUNTIME_SOURCE.sha256}`,
      `ripgrep 15.1.0: ${hostSearchArtifact().url}; MIT/Unlicense; licenses also in ripgrep.zip.`,
      '',
    ].join('\n'),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareHostRuntime(resolve(import.meta.dirname, '../corax'));
  console.log('Native host runtime ready');
}
