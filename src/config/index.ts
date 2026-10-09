import { z } from 'zod';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { AppError } from '../shared/types';
const schema = z.object({
  dataDir: z.string().default(join(homedir(), '.auto-agent')),
  skillRoots: z.array(z.string()).default([]),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(4096),
  allowRemote: z.boolean().default(false),
  token: z.string(),
  model: z.string().default('deepseek-flash'),
  systemPrompt: z.string().max(16000).optional(),
  baseURL: z.string().url().default('https://api.deepseek.com'),
  apiKey: z.string().optional(),
  maxSteps: z.number().int().positive().max(100).default(12),
  maxTokens: z.number().int().positive().default(32000),
  modelTimeoutMs: z.number().int().positive().default(60000),
  scriptTimeoutMs: z.number().int().positive().default(30000),
  outputLimitBytes: z.number().int().positive().default(65536),
  resourceLimitBytes: z.number().int().positive().default(65536),
  maxConcurrent: z.number().int().positive().default(4),
  requestLimitBytes: z.number().int().positive().default(65536),
  interpreters: z
    .record(z.string(), z.string())
    .default({ '.js': 'node', '.sh': 'bash', '.ps1': 'powershell.exe' }),
  scriptEnv: z.record(z.string(), z.string()).default({}),
});
export type Config = z.infer<typeof schema> & { noToken?: boolean; configPath?: string };
export async function ensureDefaultConfig(
  home = homedir(),
): Promise<{ path: string; created: boolean }> {
  const directory = join(home, '.auto-agent');
  const path = join(directory, 'config.json');
  await mkdir(directory, { recursive: true });
  const template = {
    dataDir: '.',
    skillRoots: [],
    host: '127.0.0.1',
    port: 4096,
    allowRemote: false,
    model: 'deepseek-flash',
    baseURL: 'https://api.deepseek.com',
    systemPrompt: '',
    interpreters: { '.js': 'node', '.sh': 'bash', '.ps1': 'powershell.exe' },
  };
  try {
    await writeFile(path, JSON.stringify(template, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { path, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { path, created: false };
    throw new AppError(
      'config_creation',
      'Cannot create default configuration. Use --config PATH with a writable data directory.',
    );
  }
}
export async function loadConfig(file?: string, noToken = false, local = false): Promise<Config> {
  const selected = file ? { path: resolve(file), created: false } : await ensureDefaultConfig();
  const path = selected.path;
  if (selected.created)
    console.log(
      `Created configuration: ${path}\nConfigure model/baseURL and set AUTO_AGENT_API_KEY before sending messages. No credentials were saved.`,
    );
  let raw: Record<string, unknown> = {};
  if (path) {
    try {
      const value: unknown = await Bun.file(path).json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      raw = value as Record<string, unknown>;
    } catch {
      throw new AppError(
        'invalid_config_file',
        'Cannot read configuration: supply a readable JSON object with --config PATH.',
      );
    }
  }
  const token = noToken || local ? '' : (process.env.AUTO_AGENT_TOKEN ?? raw.token);
  if (!noToken && !local && (typeof token !== 'string' || token.length < 16)) {
    throw new AppError(
      'invalid_token',
      'Set AUTO_AGENT_TOKEN to a random token of at least 16 characters, or provide token in --config PATH. For trusted local use, run serve --no-token (loopback only).',
    );
  }
  const parsed = schema.safeParse({
    ...raw,
    token,
    apiKey: process.env.AUTO_AGENT_API_KEY,
  });
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'configuration')),
    ];
    throw new AppError(
      'invalid_config',
      `Invalid configuration fields: ${fields.join(', ')}. Check --config PATH.`,
    );
  }
  const config: Config = { ...parsed.data, noToken, configPath: path };
  if (noToken && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    throw new AppError(
      'no_token_remote',
      '--no-token is only permitted on loopback, even with allowRemote.',
    );
  }
  const base = path ? dirname(path) : dirname(process.execPath);
  config.dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(base, config.dataDir);
  config.skillRoots = config.skillRoots.map((p) => (isAbsolute(p) ? p : resolve(base, p)));
  if (!local && !['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.allowRemote)
    throw new AppError('remote_binding', 'Non-loopback binding requires allowRemote');
  for (const value of Object.values(config.scriptEnv))
    if (config.apiKey && value.includes(config.apiKey))
      throw new AppError('script_credentials', 'Model credentials cannot be passed to scripts');
  return config;
}
