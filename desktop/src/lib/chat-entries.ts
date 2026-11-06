import type {
  CoraxMessagePart,
  CoraxDynamicToolPart,
  ChatTurnDetails,
} from '@auto-agent/desktop-protocol';

export type ChatEntry =
  | { kind: 'part'; part: Exclude<CoraxMessagePart, CoraxDynamicToolPart>; index: number }
  | { kind: 'tools'; parts: CoraxDynamicToolPart[] }
  | { kind: 'compaction'; id: string };

/** Presentation grouping only. Native parts and their order remain the source of truth. */
export function chatEntries(
  parts: readonly CoraxMessagePart[],
  compactions: ChatTurnDetails['compactions'],
): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const notices = [...compactions].sort((a, b) => a.stepIndex - b.stepIndex);
  let notice = 0;
  parts.forEach((part, index) => {
    if (part.type === 'step-start') return;
    if (part.stepIndex !== undefined)
      while (notice < notices.length && notices[notice]!.stepIndex <= part.stepIndex) {
        entries.push({ kind: 'compaction', id: notices[notice++]!.id });
      }
    if (part.type === 'dynamic-tool') {
      const previous = entries.at(-1);
      if (
        part.toolMetadata?.corax?.kind === 'tool-call' &&
        previous?.kind === 'tools' &&
        previous.parts.every((tool) => tool.toolMetadata?.corax?.kind === 'tool-call')
      )
        previous.parts.push(part);
      else entries.push({ kind: 'tools', parts: [part] });
    } else entries.push({ kind: 'part', part, index });
  });
  while (notice < notices.length) entries.push({ kind: 'compaction', id: notices[notice++]!.id });
  return entries;
}
