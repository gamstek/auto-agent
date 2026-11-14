import fs, { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { configSchema, type AppConfig } from './schema';
import { DATA_LAYOUT, defaultConfigPath } from './paths';

export { configSchema, type AppConfig } from './schema';
export { DATA_LAYOUT, defaultConfigPath, developmentConfigPath } from './paths';
export { coraxDataDirectory, ownCoraxRuntime, prepareCoraxData } from './runtime';

// One immutable process-local configuration, shared by all compiled authored modules.
const key = Symbol.for('auto-agent.runtime-config');
const revisionKey = Symbol.for('auto-agent.runtime-config-revision');
const host = globalThis as typeof globalThis & {
  [key]?: Readonly<AppConfig>;
  [revisionKey]?: string;
};
export function getRuntimeConfig(): Readonly<AppConfig> {
  if (!host[key]) {
    const absolute = resolve(process.env.AUTO_AGENT_CONFIG ?? defaultConfigPath());
    const text = readFileSync(absolute, 'utf8');
    host[key] = Object.freeze(parseConfig(absolute, text));
    host[revisionKey] = createHash('sha256').update(text).digest('hex');
  }
  return host[key];
}
export function getRuntimeConfigRevision() {
  getRuntimeConfig();
  return host[revisionKey] ?? null;
}

/** Save one live setting through the existing config, preserving pending model/path edits. */
export function saveRuntimeApprovalMode(mode: AppConfig['approvalMode']) {
  const applied = getRuntimeConfig();
  const path = resolve(process.env.AUTO_AGENT_CONFIG ?? defaultConfigPath());
  const before = readFileSync(path, 'utf8');
  const raw = JSON.parse(before);
  configSchema.parse(raw);
  const text = JSON.stringify({ ...raw, approvalMode: mode }, null, 2) + '\n';
  const persisted = parseConfig(path, text);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, text);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (readFileSync(path, 'utf8') !== before) throw new Error('Configuration revision changed');
    fs.renameSync(temporary, path);
  } catch {
    throw new Error('批准策略保存失败，尚未修改策略，请重新读取配置后再试。');
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
  // A policy update must not apply another saved-but-deferred setting.
  const withoutMode = ({ approvalMode: _mode, ...config }: Readonly<AppConfig>) => config;
  if (JSON.stringify(withoutMode(applied)) === JSON.stringify(withoutMode(persisted)))
    host[revisionKey] = createHash('sha256').update(text).digest('hex');
  host[key] = Object.freeze({ ...applied, approvalMode: mode });
}

export function ensureConfig(path = defaultConfigPath()) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  try {
    writeFileSync(path, JSON.stringify(configSchema.parse({}), null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    writeFileSync(resolve(dirname(path), '.data-layout'), DATA_LAYOUT, { mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/** Read and validate one current configuration; returned paths are absolute. */
export function loadConfig(path = process.env.AUTO_AGENT_CONFIG ?? defaultConfigPath()): AppConfig {
  const absolute = resolve(path);
  return parseConfig(absolute, readFileSync(absolute, 'utf8'));
}
function parseConfig(absolute: string, text: string): AppConfig {
  const config = configSchema.parse(JSON.parse(text));
  const fromConfig = (path: string) => resolve(dirname(absolute), path);
  return {
    ...config,
    dataDir: fromConfig(config.dataDir),
    llmWiki: {
      sources: config.llmWiki.sources.map((source) => ({
        ...source,
        path: fromConfig(source.path),
      })),
    },
  };
}
