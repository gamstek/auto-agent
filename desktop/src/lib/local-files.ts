import type { CoraxMessagePart } from '@auto-agent/desktop-protocol';

export type LocalFile = { path: string; label: string; kind?: 'file' | 'directory' };

export function localFilePath(value: string): string | undefined {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return;
  let path = value;
  if (/^file:/i.test(value)) {
    const url = URL.parse(value);
    if (!url || url.hostname || url.username || url.password || url.search || url.hash) return;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return;
    }
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return;
  return /^[a-z]:[\\/][^:]*$/i.test(path) || /^\/(?![\\/])[^\\]*$/.test(path) ? path : undefined;
}

/** Markdown encodes link destinations. Paths from tool results are literal. */
export function markdownFilePath(href: string): string | undefined {
  if (/^file:/i.test(href)) return localFilePath(href);
  if (!localFilePath(href)) return;
  try {
    return localFilePath(decodeURIComponent(href));
  } catch {
    return;
  }
}

export const localFileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function toolLocalFiles(part: CoraxMessagePart): LocalFile[] {
  if (part.type !== 'dynamic-tool' || part.state !== 'output-available' || part.partial) return [];
  let value = part.output;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== 'object') return [];
  const output = value as { artifacts?: unknown[]; supplementPdf?: unknown };
  const entries = Array.isArray(output.artifacts)
    ? output.artifacts.slice(0, 16)
    : part.toolName === 'report_analysis'
      ? [{ path: output.supplementPdf, kind: 'file' }]
      : [];
  const files = new Map<string, LocalFile>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { path: ref, label, kind } = entry as Partial<LocalFile>;
    const path = typeof ref === 'string' ? localFilePath(ref) : undefined;
    if (path && (kind === 'file' || kind === 'directory'))
      files.set(path, {
        path,
        kind,
        label: (typeof label === 'string' && label.trim()) || localFileName(path),
      });
  }
  return [...files.values()];
}
