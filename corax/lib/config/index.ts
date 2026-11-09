import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
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
