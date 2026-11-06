import { mkdir, readFile, writeFile, rename, rm, mkdtemp, link, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Manifest, PageMetadata, SourceMetadata, TextDocument } from './contracts';
import { pagePath, regularFile, sha256, decodeText } from './files';
import { DEFAULT_PURPOSE, DEFAULT_SCHEMA } from './prompts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sourceRef = z.object({ id: digest, sha256: digest }).strict();
const manifestSchema = z
  .object({
    format: z.literal(1),
    generation: z.string().uuid(),
    createdAt: z.string(),
    issues: z.array(z.string().max(4096)).max(2000),
    sources: z.record(
      digest,
      z
        .object({
          id: digest,
          name: z.string(),
          sha256: digest,
          rawPath: z.string(),
          pipelineHash: digest,
          pipelineVersion: z.string(),
          model: z.string(),
          ingestedAt: z.string(),
          pages: z.array(z.string()),
        })
        .strict(),
    ),
    pages: z.record(
      z.string(),
      z
        .object({
          title: z.string(),
          type: z.string(),
          summary: z.string(),
          sha256: digest,
          createdAt: z.string(),
          updatedAt: z.string(),
          sources: z.array(sourceRef),
          related: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

export class WikiStorage {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  private generations() {
    return join(this.directory, '.state/generations');
  }
  wikiDirectory(generation: string) {
    z.string().uuid().parse(generation);
    return join(this.generations(), generation, 'wiki');
  }

  async initialize() {
    for (let current = this.directory; ; current = dirname(current)) {
      try {
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('LLM Wiki 存储必须位于普通目录');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (dirname(current) === current) break;
    }
    await mkdir(this.generations(), { recursive: true });
    await mkdir(join(this.directory, '.state/objects'), { recursive: true });
    await mkdir(join(this.directory, 'raw/sources'), { recursive: true });
    for (const [name, content] of [
      ['purpose.md', DEFAULT_PURPOSE],
      ['schema.md', DEFAULT_SCHEMA],
    ]) {
      try {
        await writeFile(join(this.directory, name), content, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
  async context() {
    const get = async (name: string, fallback: string) => {
      try {
        return await this.text(join(this.directory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
        throw error;
      }
    };
    return {
      purpose: await get('purpose.md', DEFAULT_PURPOSE),
      schema: await get('schema.md', DEFAULT_SCHEMA),
    };
  }
  private async text(path: string) {
    const info = await regularFile(path);
    if (info.size > 16 * 1024 * 1024) throw new Error('Wiki 内部文件超出读取上限');
    return decodeText(await readFile(path));
  }
  async current(): Promise<Manifest | null> {
    let pointer: string;
    try {
      pointer = await this.text(join(this.directory, '.state/current.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const { generation } = z
      .object({ generation: z.string().uuid() })
      .strict()
      .parse(JSON.parse(pointer));
    return this.manifest(generation);
  }
  async manifest(generation: string): Promise<Manifest> {
    z.string().uuid().parse(generation);
    const manifest = manifestSchema.parse(
      JSON.parse(await this.text(join(this.generations(), generation, 'manifest.json'))),
    );
    if (manifest.generation !== generation) throw new Error('Wiki 发布标识不一致');
    for (const path of Object.keys(manifest.pages)) pagePath(path);
    for (const [id, source] of Object.entries(manifest.sources)) {
      if (source.id !== id || source.rawPath !== this.rawPath(source))
        throw new Error('Wiki 原文登记无效');
    }
    return manifest;
  }
  rawPath(source: { id: string; sha256: string }) {
    digest.parse(source.id);
    digest.parse(source.sha256);
    return `raw/sources/${source.id}/${source.sha256}.txt`;
  }
  async saveRaw(document: TextDocument) {
    if (sha256(document.text) !== document.sha256) throw new Error('导入文本哈希不一致');
    const relative = this.rawPath(document);
    const path = join(this.directory, relative);
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, document.text, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (sha256(await this.text(path)) !== document.sha256)
        throw new Error('固定版本原文已被修改');
    }
    return relative;
  }
  async readRaw(source: { id: string; sha256: string }) {
    const text = await this.text(join(this.directory, this.rawPath(source)));
    if (sha256(text) !== source.sha256) throw new Error('固定版本原文校验失败');
    return text;
  }
  async readPage(manifest: Manifest, path: string) {
    const metadata = manifest.pages[pagePath(path)];
    if (!metadata) throw new Error('Wiki 页面不存在');
    const text = await this.text(join(this.wikiDirectory(manifest.generation), path));
    if (sha256(text) !== metadata.sha256)
      throw new Error('已发布页面被修改，请明确重新摄入或恢复，不自动覆盖');
    return text;
  }

  async write<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const path = join(this.directory, '.state/write.lock');
    const contents = JSON.stringify({ pid: process.pid, token: crypto.randomUUID() });
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt++) {
      try {
        await writeFile(path, contents, { flag: 'wx' });
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const recovery = path + '.recovery';
        await writeFile(recovery, contents, { flag: 'wx' });
        try {
          await regularFile(path);
          const previous = await readFile(path, 'utf8');
          const { pid } = z
            .object({ pid: z.number().int().positive(), token: z.string() })
            .strict()
            .parse(JSON.parse(previous));
          let alive = true;
          try {
            process.kill(pid, 0);
          } catch (error) {
            alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
          }
          if (alive) throw new Error('已有 LLM Wiki 写入正在执行');
          if ((await readFile(path, 'utf8')) === previous) await rm(path);
        } finally {
          await rm(recovery);
        }
      }
    }
    if (!acquired) throw new Error('无法取得 LLM Wiki 写入权');
    try {
      return await operation();
    } finally {
      try {
        if ((await readFile(path, 'utf8').catch(() => '')) === contents) await rm(path);
      } catch {
        console.warn('LLM Wiki 写入锁清理失败，请核对目录权限；已发布内容没有回滚。');
      }
    }
  }

  async publish(
    base: Manifest | null,
    files: Map<string, string>,
    pages: Record<string, PageMetadata>,
    sources: Record<string, SourceMetadata>,
    issues: string[],
    signal: AbortSignal,
  ) {
    const generation = crypto.randomUUID();
    const manifest: Manifest = {
      format: 1,
      generation,
      createdAt: new Date().toISOString(),
      sources,
      pages,
      issues,
    };
    manifestSchema.parse(manifest);
    if (Buffer.byteLength(JSON.stringify(manifest)) > 16 * 1024 * 1024)
      throw new Error('Wiki 版本元数据超出上限，请明确整理后再摄入');
    if (
      files.size > 2000 ||
      [...files.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 32 * 1024 * 1024
    )
      throw new Error('Wiki 超过 2000 页或 32 MiB 发布上限');
    const temporary = await mkdtemp(join(this.generations(), '.pending-'));
    try {
      for (const [path, content] of files) {
        signal.throwIfAborted();
        if (/[\uD800-\uDFFF]/u.test(content)) throw new Error('生成页面包含无效 Unicode');
        decodeText(Buffer.from(content));
        if (pages[path]?.sha256 !== sha256(content)) throw new Error('Wiki 页面元数据校验失败');
        const target = join(temporary, 'wiki', pagePath(path));
        await mkdir(dirname(target), { recursive: true });
        const object = join(this.directory, '.state/objects', `${pages[path].sha256}.md`);
        try {
          await writeFile(object, content, { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (sha256(await this.text(object)) !== pages[path].sha256)
            throw new Error('持久页面对象校验失败');
        }
        try {
          await link(object, target);
        } catch (error) {
          if (
            !['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error;
          await writeFile(target, content, { flag: 'wx' });
        }
      }
      await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2));
      if ((await this.current())?.generation !== base?.generation)
        throw new Error('Wiki 发布基线已变化，请明确重新摄入');
      signal.throwIfAborted();
      await rename(temporary, join(this.generations(), generation));
      const pointer = join(this.directory, '.state', `current-${generation}.json`);
      await writeFile(pointer, JSON.stringify({ generation }));
      await rename(pointer, join(this.directory, '.state/current.json'));
      return manifest;
    } finally {
      try {
        await rm(temporary, { recursive: true, force: true });
      } catch {
        console.warn('LLM Wiki 暂存目录未能清理；发布状态以 current 指针为准。');
      }
    }
  }

  async cachedIndex(generation: string) {
    try {
      const index = JSON.parse(
        await this.text(join(this.directory, '.state/search-index.json')),
      ) as { generation: string; documents: { path: string; title: string; terms: string[] }[] };
      if (
        index.generation === generation &&
        Array.isArray(index.documents) &&
        index.documents.every(
          (row) =>
            typeof row.path === 'string' &&
            typeof row.title === 'string' &&
            Array.isArray(row.terms) &&
            row.terms.every((term) => typeof term === 'string'),
        )
      )
        return index.documents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    return null;
  }
  async saveIndex(
    generation: string,
    documents: { path: string; title: string; terms: string[] }[],
  ) {
    const temporary = join(this.directory, '.state', `index-${crypto.randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify({ generation, documents }));
    await rename(temporary, join(this.directory, '.state/search-index.json'));
  }
}
