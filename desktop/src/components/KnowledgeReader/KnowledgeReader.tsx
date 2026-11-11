import { ArrowUpRight, ChevronDown, FileText, Link2, LoaderCircle } from 'lucide-react';
import type { KnowledgePage, KnowledgePageEntry } from '@auto-agent/desktop-protocol';
import { knowledgeKind } from '../../lib/knowledge-graph';
import { Button } from '../Button/Button';
import { MarkdownAnswer } from '../MarkdownAnswer/MarkdownAnswer';
import './KnowledgeReader.css';

export function KnowledgeReader({
  selected,
  page,
  reading,
  error,
  related,
  onRead,
  onSelect,
}: {
  selected: KnowledgePageEntry;
  page?: KnowledgePage;
  reading: boolean;
  error: string;
  related: KnowledgePageEntry[];
  onRead: (entry: KnowledgePageEntry | KnowledgePage, offset?: number) => void;
  onSelect: (entry: KnowledgePageEntry) => void;
}) {
  const body = page?.text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    .replace(/^\s*#\s+([^\r\n]+)\r?\n/, (heading, title: string) =>
      title.trim() === selected.title ? '' : heading,
    );
  return (
    <article className="knowledge-preview">
      <span className="knowledge-reader-kind">{knowledgeKind(selected.type).label}</span>
      <h1>{selected.title}</h1>
      <details className="knowledge-reader-evidence">
        <summary>
          <FileText size={12} />
          来源与版本{selected.sourceCount !== undefined ? ` · ${selected.sourceCount} 份引用` : ''}
          <ChevronDown size={12} />
        </summary>
        <div>
          {selected.sourceCount !== undefined && (
            <span>
              <FileText size={12} />
              {selected.sourceCount} 份引用来源
            </span>
          )}
          {selected.updatedAt && (
            <span>更新于 {new Date(selected.updatedAt).toLocaleDateString('zh-CN')}</span>
          )}
          <span>固定发布版本 · {selected.reference.generation}</span>
          {selected.relatedTruncated && (
            <span>共有 {selected.relatedCount} 条发布关联，当前目录仅载入其中一部分。</span>
          )}
          <div className="knowledge-reader-reference">
            <code>{selected.path}</code>
            <span>SHA-256 · {selected.reference.sha256.slice(0, 12)}</span>
          </div>
        </div>
      </details>
      {reading && (
        <p className="knowledge-loading" role="status">
          <LoaderCircle className="spin" size={13} />
          正在读取知识页…
        </p>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <Button variant="subtle" onClick={() => onRead(selected)}>
            重新读取
          </Button>
        </div>
      )}
      {body && <MarkdownAnswer text={body} />}
      {page?.nextOffset !== null && page?.nextOffset !== undefined && (
        <Button variant="subtle" disabled={reading} onClick={() => onRead(page, page.nextOffset!)}>
          继续阅读
        </Button>
      )}
      {!!related.length && (
        <section className="knowledge-reader-related">
          <h2>
            <Link2 size={14} />
            相关知识
          </h2>
          {related.map((entry) => (
            <Button key={entry.path} variant="subtle" onClick={() => onSelect(entry)}>
              {entry.title}
              <ArrowUpRight size={12} />
            </Button>
          ))}
        </section>
      )}
    </article>
  );
}
