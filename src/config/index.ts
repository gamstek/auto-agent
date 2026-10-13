import { z } from 'zod';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { AppError } from '../shared/types';
import { output } from '../shared/console';
import { DEFAULT_SYSTEM_PROMPT } from '../agent/prompt';
const schema = z.object({
  // Persistent data; relative paths are resolved from the configuration file's directory.
  dataDir: z.string().default(join(homedir(), '.auto-agent')),
  // Additional trusted skill roots, relative to the configuration file.
  skillRoots: z.array(z.string()).default([]),
  // Additional wiki source roots, relative to the configuration file.
  wikiRoots: z.array(z.string()).default([]),
  // Include bundled wiki sources alongside configured roots.
  builtinWiki: z.boolean().default(true),
  // Include bundled skills alongside configured roots.
  builtinSkills: z.boolean().default(true),
  // HTTP listen address; non-loopback addresses require allowRemote.
  host: z.string().default('127.0.0.1'),
  // HTTP listen port; 0 selects an available port.
  port: z.number().int().min(0).max(65535).default(4096),
  // Permit authenticated HTTP binding outside loopback, never --no-token mode.
  allowRemote: z.boolean().default(false),
  // Permit web tools to reach loopback, private and reserved addresses; trusted deployments only.
  webAllowPrivateAddresses: z.boolean().default(true),
  // HTTP bearer token; AUTO_AGENT_TOKEN takes precedence (minimum 16 characters).
  token: z.string(),
  // Model identifier exposed by the OpenAI-compatible provider.
  model: z.string().default('deepseek-flash'),
  // Replace the default role prompt; the runtime contract is always appended.
  systemPrompt: z.string().max(16000).default(DEFAULT_SYSTEM_PROMPT),
  // OpenAI-compatible provider endpoint.
  baseURL: z.string().url().default('https://api.deepseek.com'),
  // Loaded only from AUTO_AGENT_API_KEY, not from the JSON configuration.
  apiKey: z.string().optional(),
  // Maximum model/tool-loop steps per generation (1–100).
  maxSteps: z.number().int().positive().max(100).default(12),
  // Maximum input tokens supported by the model; derived from contextWindow minus maxOutputTokens when omitted.
  maxInputTokens: z.number().int().positive().optional(),
  // Maximum output tokens supported by the model.
  maxOutputTokens: z.number().int().positive().default(16000),
  // Model's combined input/output window; derives the input capacity when provided.
  contextWindow: z.number().int().positive().optional(),
  // Model request timeout in milliseconds.
  modelTimeoutMs: z.number().int().positive().default(60000),
  // Skill script execution timeout in milliseconds.
  scriptTimeoutMs: z.number().int().positive().default(30000),
  // Combined stdout/stderr byte limit per script execution.
  outputLimitBytes: z.number().int().positive().default(65536),
  // Byte limit for skill resources, individual wiki sources, and complete wiki query responses.
  resourceLimitBytes: z.number().int().positive().default(65536),
  // Concurrent generations/scripts; background titles have a separate budget.
  maxConcurrent: z.number().int().positive().default(4),
  // HTTP request-body and user-message byte limit.
  requestLimitBytes: z.number().int().positive().default(65536),
  // Bare "node"/"node.exe" prefer installed Node, falling back to embedded Bun if absent.
  // "builtin" always uses embedded Bun; other executable names/paths remain external.
  interpreters: z
    .record(z.string(), z.string())
    .default({ '.js': 'node', '.sh': 'bash', '.ps1': 'powershell.exe' }),
  // Extra script environment entries; credential and runtime-control entries are rejected.
  scriptEnv: z.record(z.string(), z.string()).default({}),
});
export type Config = Omit<z.infer<typeof schema>, 'systemPrompt' | 'maxInputTokens'> & {
  maxInputTokens: number;
  systemPrompt?: string;
  noToken?: boolean;
  configPath?: string;
};
export async function ensureDefaultConfig(
  home = homedir(),
): Promise<{ path: string; created: boolean }> {
  const directory = join(home, '.auto-agent');
  const path = join(directory, 'config.json');
  await mkdir(directory, { recursive: true });
  // Keep the generated file strict JSON; field descriptions live here and in README.
  const template = {
    // Store persistent data next to config.json (~/.auto-agent by default).
    dataDir: '.',
    // Additional trusted skill roots, relative to config.json.
    skillRoots: [],
    // Load bundled skills even when no external roots are configured.
    builtinSkills: true,
    // Additional wiki source roots, relative to config.json.
    wikiRoots: [],
    // Load bundled wiki sources even when no external roots are configured.
    builtinWiki: true,
    // Listen only on loopback unless explicitly configured otherwise.
    host: '127.0.0.1',
    // HTTP listen port; 0 selects an available port.
    port: 4096,
    // Non-loopback HTTP requires this opt-in and bearer authentication.
    allowRemote: false,
    // Set false to restrict web tools to public internet addresses.
    webAllowPrivateAddresses: true,
    // Provider model identifier; credentials come from AUTO_AGENT_API_KEY.
    model: 'deepseek-flash',
    // Maximum input tokens supported by the model; may be replaced by contextWindow minus maxOutputTokens.
    maxInputTokens: 1000000,
    // Maximum output tokens supported by the model; actual usage is reported by the SDK.
    maxOutputTokens: 16000,
    // OpenAI-compatible endpoint for the selected model.
    baseURL: 'https://api.deepseek.com',
    // Editable role prompt; mandatory runtime instructions remain appended.
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    // Script extension → executable; bare Node falls back to embedded Bun if absent.
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
    output.info(
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
  if (raw.wikiDir !== undefined)
    throw new AppError(
      'invalid_config',
      'wikiDir was replaced by wikiRoots for external sources; repository wiki is enabled by builtinWiki',
    );
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
  for (const field of ['maxTokens', 'maxContextTokens', 'contextWindowTokens'])
    if (raw[field] !== undefined)
      throw new AppError(
        'invalid_config',
        `${field} was replaced by maxInputTokens and maxOutputTokens. Set the per-request input and output limits explicitly.`,
      );
  const contextWindow = parsed.data.contextWindow;
  const maxInputTokens =
    parsed.data.maxInputTokens ??
    (contextWindow === undefined ? 1000000 : contextWindow - parsed.data.maxOutputTokens);
  if (
    maxInputTokens <= 0 ||
    (contextWindow !== undefined && maxInputTokens > contextWindow - parsed.data.maxOutputTokens)
  )
    throw new AppError(
      'invalid_config',
      'contextWindow must accommodate maxInputTokens plus maxOutputTokens, with a positive input capacity.',
    );
  const config: Config = { ...parsed.data, maxInputTokens, noToken, configPath: path };
  if (noToken && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    throw new AppError(
      'no_token_remote',
      '--no-token is only permitted on loopback, even with allowRemote.',
    );
  }
  const base = path ? dirname(path) : dirname(process.execPath);
  config.dataDir = isAbsolute(config.dataDir) ? config.dataDir : resolve(base, config.dataDir);
  config.skillRoots = config.skillRoots.map((p) => (isAbsolute(p) ? p : resolve(base, p)));
  config.wikiRoots = [...new Set(config.wikiRoots.map((p) => resolve(base, p)))];
  if (!local && !['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.allowRemote)
    throw new AppError('remote_binding', 'Non-loopback binding requires allowRemote');
  for (const value of Object.values(config.scriptEnv))
    if (config.apiKey && value.includes(config.apiKey))
      throw new AppError('script_credentials', 'Model credentials cannot be passed to scripts');
  return config;
}
