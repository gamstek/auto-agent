import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pnpmCommand } from '../../scripts/shared/pnpm';
import { startProcess } from '../../scripts/shared/process';

const desktopRoot = resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(join(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (tag !== `v${config.version}`) throw new Error('Release tag must match desktop version');
for (const name of ['AUTO_AGENT_UPDATER_PUBLIC_KEY', 'TAURI_SIGNING_PRIVATE_KEY']) {
  if (!process.env[name]?.trim()) throw new Error(`Missing release signing configuration: ${name}`);
}
const temporary = await mkdtemp(join(tmpdir(), 'auto-agent-release-'));
try {
  const override = join(temporary, 'updater.json');
  await writeFile(
    override,
    JSON.stringify({
      bundle: { createUpdaterArtifacts: true },
      plugins: { updater: { pubkey: process.env.AUTO_AGENT_UPDATER_PUBLIC_KEY } },
    }),
  );
  const [command, ...args] = pnpmCommand(['run', 'build:desktop', '--config', override]);
  const child = startProcess(command, args, { cwd: desktopRoot, stdio: 'inherit' });
  if (await child.exited) throw new Error('Signed desktop build failed');
  const directory = join(desktopRoot, 'src-tauri/target/release/bundle/nsis');
  const expected = `Auto-Agent_${config.version}_x64-setup.exe`;
  if (!(await readdir(directory)).includes(expected)) throw new Error('Expected installer missing');
  const signature = (await readFile(join(directory, `${expected}.sig`), 'utf8')).trim();
  if (!signature) throw new Error('Updater signature missing');
  const manifest = {
    version: config.version,
    notes: await readFile(join(desktopRoot, '../.github/release-notes.md'), 'utf8'),
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': {
        signature,
        url: `https://github.com/gamstek/auto-agent/releases/download/${tag}/${expected}`,
      },
    },
  };
  await writeFile(join(directory, 'latest.json'), JSON.stringify(manifest, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
