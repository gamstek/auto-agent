import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

/** Build/development provisioning only. Installed applications never download executables. */
export async function prepareHostRuntime(project: string) {
  if (process.platform !== 'win32') return;
  const directory = hostRuntimeDirectory(project);
  await mkdir(directory, { recursive: true });
  for (const [name, artifact] of [
    ['busybox.exe', hostRuntimeArtifact()],
    ['busybox-source.tgz', HOST_RUNTIME_SOURCE],
    ['ripgrep.zip', hostSearchArtifact()],
  ] as const) {
    const target = join(directory, name);
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    if (
      await readFile(target).then(
        (bytes) => digest(bytes) === artifact.sha256,
        () => false,
      )
    )
      continue;
    const response = await fetch(artifact.url);
    if (!response.ok) throw new Error(`Host runtime download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== artifact.sha256)
      throw new Error(`Host runtime checksum mismatch: ${name}`);
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
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
