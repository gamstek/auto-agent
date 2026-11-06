import { invoke, isTauri } from '@tauri-apps/api/core';
import { DESKTOP_PROTOCOL_VERSION, type BackendHealth } from '@auto-agent/desktop-protocol';
export type { BackendHealth, BackendCapabilities } from '@auto-agent/desktop-protocol';
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
  error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : String(error);
export function sendErrorText(error: unknown) {
  const message = errorText(error);
  if (error && typeof error === 'object' && 'admission' in error && error.admission === 'rejected')
    return message;
  return `${message.replace(/[。.!！]+$/u, '')}。请先刷新会话状态确认是否已受理。`;
}
export function assertDesktopProtocol(health: BackendHealth): void {
  if (!health.healthy || health.protocolVersion !== DESKTOP_PROTOCOL_VERSION)
    throw new Error(
      '前后端接口协议不一致。请在任务结束后重新运行 pnpm dev:desktop，启动配套后端。',
    );
}
export interface Session {
  id: string;
  title: string;
  updatedAt: number;
}
export interface AgentEvent {
  type: string;
  sessionId: string;
  properties: Record<string, any>;
}
export interface ExtensionEvent {
  type: 'extension.changed';
  sessionId?: never;
  properties: { extension: string; resourceId: string; revision: number };
}
export type ServiceEvent = AgentEvent | ExtensionEvent;
export function isAgentEvent(event: ServiceEvent): event is AgentEvent {
  return typeof event.sessionId === 'string';
}
export interface Settings {
  dataDir: string;
  model: string;
  baseURL: string;
  climber: { enabled: boolean; serviceURL: string; timeoutMs: number };
  llmWiki: {
    sources: {
      id: string;
      type: 'file' | 'directory';
      path: string;
    }[];
  };
  maxInputTokens: number;
  maxOutputTokens: number;
  systemPrompt: string;
}
export interface SettingsInfo {
  configPath: string;
  configRevision: string;
  apiKeySource?: 'environment' | 'keyring';
  pendingApply?: boolean;
  settings: Settings;
  hasApiKey: boolean;
  dataDirectory: string;
  version: string;
}
