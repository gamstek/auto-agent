import { invoke, isTauri } from '@tauri-apps/api/core';
export const desktop = isTauri();
export function native<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!desktop)
    return Promise.reject(
      new Error('请通过 Tauri 桌面应用打开；浏览器预览不会连接后端或保存凭据。'),
    );
  return invoke<T>(command, args);
}
export function api<T>(path: string, method = 'GET', body?: unknown) {
  return native<T>('backend_request', { method, path, body: body ?? null });
}
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export interface BackendHealth {
  healthy: boolean;
  version: string;
  capabilities?: {
    runInspection?: number;
    persistedReasoning?: number;
    conversationProcess?: number;
  };
}
export function assertDesktopProtocol(health: BackendHealth): void {
  if (!health.healthy || health.capabilities?.runInspection !== 1 || health.capabilities?.persistedReasoning !== 1 || health.capabilities?.conversationProcess !== 1)
    throw new Error('前后端接口能力不一致。请在任务结束后退出开发命令，再运行 pnpm desktop:dev，重新构建并启动配套后端。');
}
export interface Session {
  id: string;
  title: string;
  updatedAt: number;
}
export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  runId?: string;
  createdAt: number;
}
export interface AgentEvent {
  type: string;
  sessionId: string;
  messageId: string;
  properties: Record<string, any>;
}
export interface ExtensionEvent {
  type: 'extension.changed';
  sessionId?: never;
  messageId?: never;
  properties: { extension: string; resourceId: string; revision: number };
}
export type ServiceEvent = AgentEvent | ExtensionEvent;
export function isAgentEvent(event: ServiceEvent): event is AgentEvent {
  return typeof event.sessionId === 'string' && typeof event.messageId === 'string';
}
export interface SessionState {
  running: boolean;
  run: { id: string; status: string } | null;
  pending: {
    id: string;
    executions: { id: string; status: string; diagnostic: Record<string, any> | null }[];
    operations?: { id: string; status: string; diagnostic: Record<string, any> | null }[];
  } | null;
  logs: { agent: string; skills: string };
}
export interface Settings {
  model: string;
  baseURL: string;
  manufacturerUrl: string;
  climberEnabled: boolean;
  manufacturerTimeoutMs: number;
  templateDirectory: string;
  builtinSkills: boolean;
  builtinWiki: boolean;
  skillRoots: string[];
  wikiRoots: string[];
  wikiIndexRoots: string[];
  maxSteps: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  modelTimeoutMs: number;
  scriptTimeoutMs: number;
  webAllowPrivateAddresses: boolean;
  systemPrompt: string;
}
export interface SettingsInfo {
  configPath: string;
  configRevision: string;
  apiKeySource?: 'environment' | 'keyring';
  deviceConnectionSource?: 'mcp' | 'script';
  pendingApply?: boolean;
  settings: Settings;
  hasApiKey: boolean;
  dataDirectory: string;
  version: string;
}
