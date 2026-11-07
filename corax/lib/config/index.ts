import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { configSchema, type AppConfig } from './schema';
import { DATA_LAYOUT, defaultConfigPath } from './paths';

export { configSchema, type AppConfig } from './schema';
export { DATA_LAYOUT, defaultConfigPath, developmentConfigPath } from './paths';
export { coraxDataDirectory, ownCoraxRuntime, prepareCoraxData } from './runtime';

// One immutable process-local configuration, shared by all compiled authored modules.
const key = Symbol.for('auto-agent.runtime-config');
const host = globalThis as typeof globalThis & { [key]?: Readonly<AppConfig> };
export function getRuntimeConfig(): Readonly<AppConfig> {
  return (host[key] ??= Object.freeze(loadConfig()));
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
  const config = configSchema.parse(JSON.parse(readFileSync(absolute, 'utf8')));
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
