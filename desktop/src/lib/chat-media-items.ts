import {
  toolMedia,
  type ChatCallState,
  type ChatMedia,
  type CoraxMessage,
} from '@auto-agent/desktop-protocol';

type MediaItem = { id: string; callId: string; media: ChatMedia; route?: string };

export function messageMedia(
  message: CoraxMessage,
  calls: Readonly<Record<string, ChatCallState>>,
  sessionId: string,
) {
  const items = new Map<string, MediaItem>();
  for (const part of message.parts) {
    if (part.type !== 'dynamic-tool' || part.state !== 'output-available' || part.partial) continue;
    const index = calls[part.toolCallId]?.mediaEventIndex;
    toolMedia(part.toolName, part.output).forEach((media, slot) => {
      const route =
        index === undefined
          ? undefined
          : `/chat-media?session=${sessionId}&index=${index}&slot=${slot}`;
      if (!route && media.kind !== 'data') return;
      const key = media.kind === 'file' ? media.path : media.url;
      items.set(key, {
        id: `${sessionId}:${part.toolCallId}:${slot}`,
        callId: part.toolCallId,
        media,
        route,
      });
    });
  }
  const media = [...items.values()];
  if (message.metadata?.status !== 'complete') return media;
  const texts = message.parts.filter((part) => part.type === 'text');
  const last = texts.at(-1);
  if (!last) return media;
  const normalize = (value: string) => value.replace(/\\+/g, '/').toLowerCase();
  const delivered = normalize(
    last.stepIndex === undefined
      ? last.text
      : texts
          .filter((part) => part.stepIndex === last.stepIndex)
          .map((part) => part.text)
          .join('\n'),
  );
  const isLocalImage = (item: MediaItem) =>
    item.media.kind === 'file' && item.media.mediaType.startsWith('image/');
  const named = (item: MediaItem) =>
    item.media.kind === 'file' && delivered.includes(normalize(item.media.path));
  return media.some((item) => isLocalImage(item) && named(item))
    ? media.filter((item) => !isLocalImage(item) || named(item))
    : media;
}
