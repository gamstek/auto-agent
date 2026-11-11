import { join } from 'node:path';
import { WikiStorage } from './storage';
import { sha256, pagePath, decodeText, isTextPath } from './files';
import {
  generatedPagesSchema,
  pageReferenceSchema,
  type Manifest,
  type PageReference,
  type PageMetadata,
  type SourceReference,
  type TextDocument,
  type IngestModel,
  type GeneratedPage,
  type IngestResult,
} from './contracts';
import { analysisPrompt, generationPrompt, PIPELINE_VERSION } from './prompts';
export { discoverText } from './files';
export * from './contracts';

const managed = new Set(['index.md', 'overview.md', 'log.md']);
const directories = { source: 'sources', entity: 'entities', concept: 'concepts', topic: 'topics' };
interface CatalogPage {
  path: string;
  title: string;
  type: string;
  summary: string;
  reference: PageReference;
  related: string[];
  relatedCount: number;
  relatedTruncated: boolean;
  sourceCount: number;
  updatedAt: string;
}
interface CatalogSource {
  name: string;
  nameTruncated: boolean;
  reference: SourceReference;
  ingestedAt: string;
  model: string;
  pipelineVersion: string;
}
interface WikiCatalog {
  published: boolean;
  directory: string;
  pages: CatalogPage[];
  sources: CatalogSource[];
  nextOffset: number | null;
  generation?: string;
  wikiDirectory?: string;
  sourceCount?: number;
  index?: PageReference;
  overview?: PageReference;
  unresolved?: { id: string; message: string; messageTruncated?: boolean }[];
  unresolvedCount?: number;
  note?: string;
}
export function terms(text: string) {
  const result = new Set<string>();
  for (const word of text
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      for (let i = 0; i < chars.length; i++) {
        result.add(chars[i]);
        if (i + 1 < chars.length) result.add(chars[i] + chars[i + 1]);
      }
    } else result.add(word);
  }
  return [...result];
}
function paginate(text: string, offset: number, limit: number, maxBytes: number) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    maxBytes < 1024 ||
    maxBytes > 262144
  )
    throw new Error('文本分页参数无效');
  const lines = text.split(/\r?\n/);
  const selected: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > maxBytes) break;
    selected.push(line);
    bytes += size;
  }
  if (offset < lines.length && !selected.length)
    throw new Error('单行超出读取预算，请提高 maxBytes');
  return {
    text: selected.join('\n'),
    startLine: offset + 1,
    endLine: offset + selected.length,
    nextOffset: offset + selected.length < lines.length ? offset + selected.length : null,
  };
}
function body(page: GeneratedPage, createdAt: string, updatedAt: string) {
  return `---\ntype: ${page.type}\ntitle: ${JSON.stringify(page.title)}\ncreated: ${createdAt.slice(0, 10)}\nupdated: ${updatedAt.slice(0, 10)}\nsources: ${JSON.stringify(page.sources)}\nrelated: ${JSON.stringify(page.related)}\n---\n\n${page.body}\n`;
}
function metadata(
  page: GeneratedPage,
  text: string,
  createdAt: string,
  updatedAt: string,
): PageMetadata {
  return {
    title: page.title,
    type: page.type,
    summary: page.summary,
    sources: page.sources,
    related: page.related,
    sha256: sha256(text),
    createdAt,
    updatedAt,
  };
}
function linkTargets(text: string) {
  return [...text.replace(/```[\s\S]*?```/g, '').matchAll(/\[\[([^\]\n]+)\]\]/g)]
    .map((match) => match[1].split('|')[0].split('#')[0])
    .filter(Boolean)
    .map((path) => (path.endsWith('.md') ? path : path + '.md'));
}
function overview(pages: Record<string, PageMetadata>, issues: string[]) {
  return (
    '# 知识概览\n\n' +
    Object.entries(pages)
      .filter(([path, page]) => !managed.has(path) && page.type !== 'source')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, page]) => `## [[${path.replace(/\.md$/, '')}|${page.title}]]\n${page.summary}\n`)
      .join('\n') +
    (issues.length ? '\n## 待确认\n' + issues.map((issue) => `- ${issue}`).join('\n') : '')
  );
}
const issueRecords = (issues: string[]) =>
  issues.map((message) => ({ id: sha256(message), message }));

/** Persistent Markdown knowledge, separate from built-in device evidence and Corax history. */
export class LlmWiki {
  readonly storage: WikiStorage;
  constructor(directory: string) {
    this.storage = new WikiStorage(directory);
  }

  async catalog(offset = 0, limit = 30, generation?: string): Promise<WikiCatalog> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('目录分页参数无效');
    const manifest = generation
      ? await this.storage.manifest(generation)
      : await this.storage.current();
    if (!manifest)
      return {
        published: false,
        directory: this.storage.directory,
        pages: [],
        sources: [],
        nextOffset: null,
        note: '尚无已摄入知识，请显式导入纯文本并执行 ingest。',
      };
    const paths = Object.keys(manifest.pages).sort();
    const sourceList = Object.values(manifest.sources).sort((a, b) => a.name.localeCompare(b.name));
    const pages: CatalogPage[] = [],
      sources: CatalogSource[] = [];
    let count = 0;
    for (const path of paths.slice(offset, offset + limit)) {
      const page = manifest.pages[path];
      const related: string[] = [];
      let relatedBytes = 2;
      for (const target of page.related) {
        const size = Buffer.byteLength(JSON.stringify(target)) + 1;
        if (relatedBytes + size > 8192) break;
        related.push(target);
        relatedBytes += size;
      }
      const entry = {
        path,
        title: page.title,
        type: page.type,
        summary: page.summary,
        reference: this.reference(manifest, path),
        related,
        relatedCount: page.related.length,
        relatedTruncated: related.length !== page.related.length,
        sourceCount: page.sources.length,
        updatedAt: page.updatedAt,
      };
      const source = sourceList[offset + count];
      const sourceEntry = source
        ? {
            name: source.name.slice(0, 400),
            nameTruncated: source.name.length > 400,
            reference: { id: source.id, sha256: source.sha256 },
            ingestedAt: source.ingestedAt,
            model: source.model,
            pipelineVersion: source.pipelineVersion,
          }
        : null;
      if (
        Buffer.byteLength(
          JSON.stringify({
            pages: [...pages, entry],
            sources: sourceEntry ? [...sources, sourceEntry] : sources,
          }),
        ) > 40000
      )
        break;
      pages.push(entry);
      if (sourceEntry) sources.push(sourceEntry);
      count++;
    }
    return {
      published: true,
      directory: this.storage.directory,
      generation: manifest.generation,
      wikiDirectory: this.storage.wikiDirectory(manifest.generation),
      sourceCount: sourceList.length,
      pages,
      sources,
      nextOffset: offset + count < paths.length ? offset + count : null,
      index: this.reference(manifest, 'index.md'),
      overview: this.reference(manifest, 'overview.md'),
      unresolved: issueRecords(manifest.issues.slice(0, 20)).map((issue) => ({
        ...issue,
        message: issue.message.slice(0, 400),
        messageTruncated: issue.message.length > 400,
      })),
      unresolvedCount: manifest.issues.length,
    };
  }
  async initialize() {
    await this.storage.write(async () => {});
    return {
      directory: this.storage.directory,
      purpose: join(this.storage.directory, 'purpose.md'),
      schema: join(this.storage.directory, 'schema.md'),
      note: '只创建文本维护规则，未调用模型或生成知识。',
    };
  }
  private reference(manifest: Manifest, path: string): PageReference {
    return { generation: manifest.generation, path, sha256: manifest.pages[path].sha256 };
  }
  private async index(manifest: Manifest) {
    const cached = await this.storage.cachedIndex(manifest.generation);
    const expected = Object.keys(manifest.pages).filter((path) => !managed.has(path));
    if (
      cached &&
      cached.length === expected.length &&
      new Set(cached.map((row) => row.path)).size === expected.length &&
      cached.every(
        (row) =>
          expected.includes(row.path) &&
          row.title === manifest.pages[row.path].title &&
          terms(row.title).every((term) => row.terms.includes(term)),
      )
    )
      return cached;
    const index = [];
    for (const [path, metadata] of Object.entries(manifest.pages))
      if (!managed.has(path)) {
        index.push({
          path,
          title: metadata.title,
          terms: terms(metadata.title + '\n' + (await this.storage.readPage(manifest, path))),
        });
      }
    return index;
  }
  async search(query: string, offset = 0, limit = 5) {
    if (
      query.length > 1000 ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      limit < 1 ||
      limit > 20
    )
      throw new Error('查询参数无效');
    const manifest = await this.storage.current();
    if (!manifest) return { results: [], nextOffset: null, note: '尚无已摄入知识' };
    const words = terms(query);
    const ranked = (await this.index(manifest))
      .map((row) => ({
        ...row,
        score:
          words.reduce(
            (score, word) =>
              score +
              (row.terms.includes(word) ? 1 : 0) +
              (row.title.toLowerCase().includes(word) ? 3 : 0),
            0,
          ) + (query && row.title.includes(query) ? 10 : 0),
      }))
      .filter((row) => row.score > 0 && manifest.pages[row.path])
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const results = [];
    for (const row of ranked.slice(offset, offset + limit)) {
      const text = await this.storage.readPage(manifest, row.path);
      const lines = text.split(/\r?\n/);
      const found = lines.findIndex((line) =>
        words.some((word) => line.toLowerCase().includes(word)),
      );
      const start = Math.max(0, found - 1);
      const excerpt = lines.slice(start, start + 8).join('\n');
      results.push({
        title: row.title,
        reference: this.reference(manifest, row.path),
        sources: manifest.pages[row.path].sources,
        snippet: excerpt.slice(0, 1000),
        snippetTruncated: excerpt.length > 1000 || start + 8 < lines.length,
        startLine: start + 1,
      });
    }
    return {
      generation: manifest.generation,
      results,
      nextOffset: offset + limit < ranked.length ? offset + limit : null,
    };
  }
  async read(reference: PageReference, offset = 0, limit = 60, maxBytes = 32768) {
    const ref = pageReferenceSchema.parse(reference);
    const manifest = await this.storage.manifest(ref.generation);
    if (manifest.pages[ref.path]?.sha256 !== ref.sha256)
      throw new Error('Wiki 页面引用与版本不匹配');
    return {
      reference: ref,
      title: manifest.pages[ref.path].title,
      sources: manifest.pages[ref.path].sources,
      ...paginate(await this.storage.readPage(manifest, ref.path), offset, limit, maxBytes),
    };
  }
  async source(
    generation: string,
    reference: SourceReference,
    offset = 0,
    limit = 60,
    maxBytes = 32768,
  ) {
    const manifest = await this.storage.manifest(generation);
    const known =
      manifest.sources[reference.id]?.sha256 === reference.sha256 ||
      Object.values(manifest.pages).some((page) =>
        page.sources.some((ref) => ref.id === reference.id && ref.sha256 === reference.sha256),
      );
    if (!known) throw new Error('原文引用不属于该知识版本');
    return {
      generation,
      reference,
      name: manifest.sources[reference.id]?.name,
      originalVerified: false,
      ...paginate(await this.storage.readRaw(reference), offset, limit, maxBytes),
    };
  }

  private async completeSource(base: Manifest, document: Pick<TextDocument, 'id' | 'sha256'>) {
    const existing = base.sources[document.id];
    if (!existing?.pages.length) return false;
    for (const path of existing.pages) {
      if (
        !base.pages[path]?.sources.some(
          (ref) => ref.id === document.id && ref.sha256 === document.sha256,
        )
      )
        return false;
      await this.storage.readPage(base, path);
    }
    return true;
  }

  /** Read-only inspection; source selection alone never initializes or compiles a Wiki. */
  async inspectSources(
    documents: readonly Pick<TextDocument, 'id' | 'name' | 'sha256'>[],
    modelIdentity: string,
  ) {
    const base = await this.storage.current();
    const context = await this.storage.context();
    const pipelineHash = sha256(JSON.stringify([PIPELINE_VERSION, modelIdentity, context]));
    const sources = [];
    for (const document of documents) {
      const existing = base?.sources[document.id];
      let status: 'pending' | 'ready' | 'changed' | 'error' = 'pending';
      let message: string | undefined;
      if (existing) {
        if (existing.sha256 !== document.sha256 || existing.pipelineHash !== pipelineHash) {
          status = 'changed';
        } else {
          try {
            status = base && (await this.completeSource(base, document)) ? 'ready' : 'changed';
          } catch (error) {
            status = 'error';
            message = [...(error instanceof Error ? error.message : '知识页校验失败')]
              .slice(0, 1200)
              .join('');
          }
        }
      }
      sources.push({
        id: document.id,
        name: document.name,
        status,
        pageCount: existing?.pages.length ?? 0,
        ingestedAt: existing?.ingestedAt,
        message,
      });
    }
    return {
      published: !!base,
      generation: base?.generation,
      wikiDirectory: base ? this.storage.wikiDirectory(base.generation) : undefined,
      pageCount: Object.keys(base?.pages ?? {}).filter((path) => !managed.has(path)).length,
      sources,
    };
  }

  async ingest(
    document: TextDocument,
    model: IngestModel,
    signal: AbortSignal,
  ): Promise<IngestResult> {
    if (
      !/^[a-f0-9]{64}$/.test(document.id) ||
      !isTextPath(document.name) ||
      !document.text.trim() ||
      sha256(document.text) !== document.sha256 ||
      Buffer.byteLength(document.text) > 1024 * 1024
    )
      throw new Error('纯文本来源身份、格式、内容或大小无效');
    decodeText(Buffer.from(document.text));
    return this.storage.write(async () => {
      signal.throwIfAborted();
      const base = await this.storage.current();
      const context = await this.storage.context();
      const pipelineHash = sha256(JSON.stringify([PIPELINE_VERSION, model.identity, context]));
      const rawPath = await this.storage.saveRaw(document);
      const existing = base?.sources[document.id];
      if (existing?.sha256 === document.sha256 && existing.pipelineHash === pipelineHash && base) {
        if (await this.completeSource(base, document))
          return {
            source: document.name,
            reused: true,
            generation: base.generation,
            pages: existing.pages,
          };
      }
      const oldFiles = new Map<string, string>();
      if (base)
        for (const path of Object.keys(base.pages))
          oldFiles.set(path, await this.storage.readPage(base, path));
      const currentRef = { id: document.id, sha256: document.sha256 };
      const allowedReferences = new Map<string, SourceReference>([
        [JSON.stringify(currentRef), currentRef],
      ]);
      const relevant = new Map<string, string>();
      let contextBytes = 0;
      const add = (path: string, required: boolean) => {
        if (relevant.has(path) || managed.has(path) || !base?.pages[path]) return;
        const content = oldFiles.get(path)!;
        if (contextBytes + Buffer.byteLength(content) > model.maxPromptBytes / 3) {
          if (required) throw new Error('相关知识页超出模型预算，请提升输入容量');
          return;
        }
        relevant.set(path, content);
        contextBytes += Buffer.byteLength(content);
        for (const ref of base.pages[path].sources) allowedReferences.set(JSON.stringify(ref), ref);
      };
      for (const path of existing?.pages ?? []) add(path, true);
      const documentTerms = terms(document.name + '\n' + document.text.slice(0, 12000));
      for (const [path] of Object.entries(base?.pages ?? {})
        .sort(
          (a, b) =>
            documentTerms.filter((term) => b[1].title.includes(term)).length -
            documentTerms.filter((term) => a[1].title.includes(term)).length,
        )
        .slice(0, 5))
        add(path, false);
      const allNavigation = Object.entries(base?.pages ?? {})
        .filter(([path]) => !managed.has(path))
        .map(([path, page]) => ({ path, title: page.title, summary: page.summary }));
      const navigation = [];
      let navigationBytes = 0;
      for (const entry of allNavigation) {
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (navigationBytes + size > model.maxPromptBytes / 8) break;
        navigation.push(entry);
        navigationBytes += size;
      }
      const sourcePage = `sources/${document.id}.md`;
      const background = JSON.stringify({
        source: { name: document.name, reference: currentRef, summaryPath: sourcePage },
        index: { pages: navigation, omitted: allNavigation.length - navigation.length },
        existingPages: [...relevant].map(([path, text]) => ({ path, text })),
        allowedSources: [...allowedReferences.values()],
      });
      if (Buffer.byteLength(background) > model.maxPromptBytes / 2)
        throw new Error('现有 Wiki 导航和关联内容超出模型预算');
      const size = Math.min(
        12000,
        Math.floor((model.maxPromptBytes - Buffer.byteLength(background)) / 8),
      );
      if (size < 1000) throw new Error('模型输入容量不足，无法摄入');
      const characters = [...document.text];
      const count = Math.max(1, Math.ceil(characters.length / size));
      if (count > 24) throw new Error('原文超过单次摄入的 24 个分析分段，请先拆分资料');
      const analyses = [];
      for (let i = 0; i < count; i++) {
        signal.throwIfAborted();
        const analysis = await model.complete({
          stage: 'analysis',
          system: analysisPrompt(context.purpose, context.schema),
          prompt: `${background}\n\n原文分段 ${i + 1}/${count}：\n${characters.slice(i * size, (i + 1) * size).join('')}`,
          signal,
        });
        if (!analysis.trim() || analysis.length > 12000)
          throw new Error('分析结果为空或过长，未生成知识页');
        analyses.push(analysis);
      }
      signal.throwIfAborted();
      const output = await model.complete({
        stage: 'generation',
        system: generationPrompt(context.purpose, context.schema),
        prompt: `${background}\n\n最终分析：\n${analyses.join('\n\n')}\n\n${count === 1 ? `原文：\n${document.text}` : '完整原文已分段分析，引用必须指向提供的固定原文版本。'}`,
        signal,
      });
      const unfenced = output.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
      const generated = generatedPagesSchema.parse(JSON.parse(unfenced));
      const patch = new Map<string, GeneratedPage>();
      const portablePaths = new Map(
        Object.keys(base?.pages ?? {}).map((path) => [path.normalize('NFKC').toLowerCase(), path]),
      );
      for (const page of generated.pages) {
        pagePath(page.path);
        decodeText(Buffer.from(page.body));
        if (
          page.path.split('/').length !== 2 ||
          page.path.split('/')[0] !== directories[page.type] ||
          managed.has(page.path) ||
          page.body.startsWith('---')
        )
          throw new Error(`页面类型或正文格式无效：${page.path}`);
        if (patch.has(page.path)) throw new Error('生成了重复页面');
        const portable = page.path.normalize('NFKC').toLowerCase();
        if (portablePaths.has(portable) && portablePaths.get(portable) !== page.path)
          throw new Error('页面名存在大小写或 Unicode 冲突');
        portablePaths.set(portable, page.path);
        if (base?.pages[page.path] && !relevant.has(page.path))
          throw new Error('不能覆盖未提供完整上下文的现有页面');
        if (
          !page.sources.some(
            (ref) => ref.id === currentRef.id && ref.sha256 === currentRef.sha256,
          ) ||
          page.sources.some((ref) => !allowedReferences.has(JSON.stringify(ref)))
        )
          throw new Error('生成内容的来源引用无效');
        if (
          base?.pages[page.path]?.sources.some(
            (ref) =>
              ref.id !== document.id &&
              !page.sources.some((next) => next.id === ref.id && next.sha256 === ref.sha256),
          )
        )
          throw new Error('更新页面不能丢弃其他来源的证据引用');
        if (page.type === 'source' && page.path !== sourcePage)
          throw new Error('不能虚构额外来源摘要');
        patch.set(page.path, page);
      }
      if (!patch.has(sourcePage)) throw new Error('LLM 未生成要求的来源摘要');
      const knownPages = new Set([...Object.keys(base?.pages ?? {}), ...patch.keys(), ...managed]);
      for (const page of patch.values())
        for (const target of [...page.related, ...linkTargets(page.body)]) {
          if (!knownPages.has(pagePath(target))) throw new Error(`交叉引用不存在：${target}`);
        }
      const now = new Date().toISOString();
      const files = new Map(oldFiles);
      const pages = { ...base?.pages };
      for (const [path, page] of patch) {
        const createdAt = base?.pages[path]?.createdAt ?? now;
        const text = body(page, createdAt, now);
        files.set(path, text);
        pages[path] = metadata(page, text, createdAt, now);
      }
      const sources = {
        ...base?.sources,
        [document.id]: {
          id: document.id,
          name: document.name,
          sha256: document.sha256,
          rawPath,
          pipelineHash,
          pipelineVersion: PIPELINE_VERSION,
          model: model.label ?? model.identity,
          ingestedAt: now,
          pages: [...patch.keys()],
        },
      };
      const unresolved = [
        ...new Set([
          ...(base?.issues ?? []),
          ...generated.issues.map((issue) => `[${document.id}@${document.sha256}] ${issue}`),
        ]),
      ];
      const contentPages = Object.entries(pages)
        .filter(([path]) => !managed.has(path))
        .sort(([a], [b]) => a.localeCompare(b));
      const index =
        '# LLM Wiki\n\n' +
        contentPages
          .map(
            ([path, page]) => `- [[${path.replace(/\.md$/, '')}|${page.title}]] — ${page.summary}`,
          )
          .join('\n') +
        '\n';
      const overviewText = overview(pages, unresolved);
      const log =
        (oldFiles.get('log.md') ?? '# LLM Wiki 维护日志\n') +
        `\n## [${now.slice(0, 10)}] ingest | ${document.name.replace(/[\r\n]/g, ' ')}\n\n来源：${document.id}@${document.sha256}\n分析分段：${count}；更新页面：${[...patch.keys()].join('、')}\n${generated.issues.map((issue) => `- ${issue}`).join('\n')}\n`;
      for (const [path, title, text] of [
        ['index.md', '知识目录', index],
        ['overview.md', '知识概览', overviewText],
        ['log.md', '维护日志', log],
      ]) {
        files.set(path, text);
        pages[path] = {
          title,
          type: 'navigation',
          summary: title,
          sources: [],
          related: [],
          sha256: sha256(text),
          createdAt: base?.pages[path]?.createdAt ?? now,
          updatedAt: now,
        };
      }
      // A model call may take minutes: recheck human-owned context and baseline content before publishing.
      if (JSON.stringify(await this.storage.context()) !== JSON.stringify(context))
        throw new Error('摄入期间 purpose/schema 已变化，未发布');
      if (base) for (const path of Object.keys(base.pages)) await this.storage.readPage(base, path);
      const published = await this.storage.publish(base, files, pages, sources, unresolved, signal);
      return {
        source: document.name,
        reused: false,
        generation: published.generation,
        wikiDirectory: this.storage.wikiDirectory(published.generation),
        pages: [...patch.keys()],
        issues: generated.issues,
      };
    });
  }

  async reindex() {
    return this.storage.write(async () => {
      const manifest = await this.storage.current();
      if (!manifest) throw new Error('尚无已发布知识；reindex 不调用 LLM，也不代替 ingest');
      const documents = [];
      for (const [path, page] of Object.entries(manifest.pages))
        if (!managed.has(path))
          documents.push({
            path,
            title: page.title,
            terms: terms(page.title + '\n' + (await this.storage.readPage(manifest, path))),
          });
      await this.storage.saveIndex(manifest.generation, documents);
      return { generation: manifest.generation, indexedPages: documents.length };
    });
  }
  async resolve(issueId: string, note: string, signal: AbortSignal) {
    if (!/^[a-f0-9]{64}$/.test(issueId) || !note.trim() || note.length > 2000)
      throw new Error('待确认记录或处理说明无效');
    return this.storage.write(async () => {
      const base = await this.storage.current();
      const issue = base?.issues.find((message) => sha256(message) === issueId);
      if (!base || !issue) throw new Error('待确认记录不存在或已经处理，请重新读取目录');
      const files = new Map<string, string>();
      for (const path of Object.keys(base.pages))
        files.set(path, await this.storage.readPage(base, path));
      const issues = base.issues.filter((message) => sha256(message) !== issueId);
      const now = new Date().toISOString();
      files.set('overview.md', overview(base.pages, issues));
      files.set(
        'log.md',
        files.get('log.md')! +
          `\n## [${now.slice(0, 10)}] resolve | ${issueId}\n\n原记录：${issue}\n\n用户处理说明：${note.trim()}\n\n仅关闭待确认记录，未自动改写知识正文或给予科学批准。\n`,
      );
      const pages = { ...base.pages };
      for (const path of ['overview.md', 'log.md'])
        pages[path] = { ...pages[path], sha256: sha256(files.get(path)!), updatedAt: now };
      const published = await this.storage.publish(
        base,
        files,
        pages,
        base.sources,
        issues,
        signal,
      );
      return {
        generation: published.generation,
        handled: issueId,
        note,
        contentPagesUnchanged: true,
      };
    });
  }
  async lint() {
    const manifest = await this.storage.current();
    if (!manifest)
      return { healthy: true, pages: 0, issues: [], scope: 'structure-and-provenance' };
    const issues: { path: string; message: string }[] = [];
    const historicalReferences: { path: string; reference: SourceReference }[] = [];
    for (const [path, page] of Object.entries(manifest.pages)) {
      try {
        const text = await this.storage.readPage(manifest, path);
        for (const target of [...page.related, ...linkTargets(text)])
          if (!manifest.pages[target]) issues.push({ path, message: `缺少页面：${target}` });
        for (const ref of page.sources) {
          await this.storage.readRaw(ref);
          if (manifest.sources[ref.id]?.sha256 !== ref.sha256)
            historicalReferences.push({ path, reference: ref });
        }
      } catch (error) {
        issues.push({ path, message: error instanceof Error ? error.message : '内容读取失败' });
      }
    }
    return {
      healthy: !issues.length,
      pages: Object.keys(manifest.pages).length,
      generation: manifest.generation,
      issues,
      historicalReferences,
      unresolved: issueRecords(manifest.issues),
      scope: 'structure-and-provenance',
      note: '历史引用不一定过时；结构和来源检查不等于语义无矛盾或科学结论已获认可。',
    };
  }
}
