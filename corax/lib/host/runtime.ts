import { join } from 'node:path';

export const HOST_RUNTIME_VERSION = 'FRP-6354-g5f09fb446';
export const HOST_RUNTIME_SOURCE = {
  url: `https://frippery.org/files/busybox/busybox-w32-${HOST_RUNTIME_VERSION}.tgz`,
  sha256: '950d2c73e979e54c65c7723668406d1d6e740fc474f41516a82ddae805fbf24b',
};

export function hostRuntimeArtifact(arch: string = process.arch) {
  if (arch !== 'x64' && arch !== 'arm64')
    throw new Error(`Unsupported Windows host architecture: ${arch}`);
  return {
    url: `https://frippery.org/files/busybox/busybox-${arch === 'x64' ? 'w64u' : 'w64a'}-${HOST_RUNTIME_VERSION}.exe`,
    sha256:
      arch === 'x64'
        ? '36b266923fc5765b42f5f981319f39568498fba60b53ccf26e8fc1e575e2a9a9'
        : 'ef426a4967f0a4657343242e85c290a8fb3272c6145c230439c587a0a97f9969',
  };
}

export function hostRuntimeDirectory(project: string, arch: string = process.arch) {
  return join(project, 'assets/host', `win32-${arch}`);
}

export function hostSearchArtifact(arch: string = process.arch) {
  hostRuntimeArtifact(arch);
  const directory = `ripgrep-15.1.0-${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`;
  return {
    directory,
    url: `https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/${directory}.zip`,
    sha256:
      arch === 'x64'
        ? '124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a'
        : '00d931fb5237c9696ca49308818edb76d8eb6fc132761cb2a1bd616b2df02f8e',
  };
}
