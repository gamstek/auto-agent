export const mediaTypes = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const;
export type MediaType = (typeof mediaTypes)[number];
export const isMediaType = (type: unknown): type is MediaType =>
  mediaTypes.some((value) => value === type);
export const inlineMediaLimit = 1024 * 1024;

export type ChatMedia = {
  mediaType: MediaType;
  filename: string;
  width?: number;
  height?: number;
} & (
  | { kind: 'data'; url: string }
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string; size: number }
);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const dimension = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 8192
    ? value
    : undefined;

export function mediaFile(value: unknown): ChatMedia | undefined {
  const part = record(value);
  const mediaType = part.mediaType ?? part.mimeType;
  if (!isMediaType(mediaType)) return;
  const info = {
    mediaType,
    filename:
      typeof part.filename === 'string'
        ? part.filename
        : mediaType.startsWith('image/')
          ? '图片'
          : '视频',
    width: dimension(part.width),
    height: dimension(part.height),
  };
  const url =
    typeof part.url === 'string'
      ? part.url
      : typeof part.data === 'string'
        ? `data:${mediaType};base64,${part.data}`
        : '';
  if (
    url.length <= Math.ceil(inlineMediaLimit / 3) * 4 + 32 &&
    url.startsWith(`data:${mediaType};base64,`) &&
    /^[a-zA-Z0-9+/]+={0,2}$/.test(url.slice(url.indexOf(',') + 1))
  )
    return { ...info, kind: 'data', url };
  if (url.length <= 8192 && /^https?:\/\//i.test(url)) {
    const parsed = URL.parse(url);
    if (
      parsed &&
      ['http:', 'https:'].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    )
      return { ...info, kind: 'url', url: parsed.href };
  }
}

/** Corax preserves native read_file metadata; authored producers may return typed content parts. */
export function toolMedia(toolName: string, raw: unknown): ChatMedia[] {
  let output = raw;
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output);
    } catch {
      return [];
    }
  }
  const result = record(output);
  const file = record(result.file);
  if (
    toolName === 'read_file' &&
    isMediaType(file.mediaType) &&
    file.mediaType.startsWith('image/') &&
    typeof result.path === 'string' &&
    typeof file.size === 'number' &&
    Number.isSafeInteger(file.size) &&
    file.size > 0
  ) {
    return [
      {
        kind: 'file',
        path: result.path,
        size: file.size,
        mediaType: file.mediaType,
        filename: result.path.split(/[\\/]/).at(-1) || '图片',
        width: dimension(file.width),
        height: dimension(file.height),
      },
    ];
  }
  const parts = Array.isArray(output)
    ? output
    : result.type === 'content'
      ? result.value
      : (result.attachments ?? result.content);
  if (!Array.isArray(parts)) return [];
  return parts.slice(0, 16).flatMap((part) => {
    if (
      !['image', 'video', 'file', 'image-data', 'image-url', 'file-data', 'file-url'].includes(
        String(record(part).type),
      )
    )
      return [];
    const media = mediaFile(part);
    return media ? [media] : [];
  });
}
