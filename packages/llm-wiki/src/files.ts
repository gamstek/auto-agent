import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { textSourceSchema, type TextDocument, type TextSource } from './contracts';

export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const isTextPath = (path: string) =>
  ['.md', '.markdown', '.txt'].includes(extname(path).toLowerCase());
export function decodeText(bytes: Uint8Array): string {
  if (Buffer.from(bytes.subarray(0, 16)).toString() === 'SQLite format 3\0' || bytes.includes(0))
    throw new Error('只接受纯文本，不接受 SQLite 或其他二进制内容');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('文本必须是有效 UTF-8');
  }
}
export function pagePath(path: string) {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    /[<>:"|?*\x00-\x1f]/.test(path) ||
    !path.endsWith('.md') ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[ .]$/.test(part) ||
          Buffer.byteLength(part) > 240 ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error(`Wiki 页面路径无效：${path}`);
  return path;
}
export async function regularFile(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink())
      throw new Error('资料和 Wiki 路径不能通过符号链接');
    if (dirname(current) === current) break;
  }
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error('不是普通文本文件');
  return stat;
}
export async function readText(path: string) {
  const before = await regularFile(path);
  if (before.size > 1024 * 1024) throw new Error('单份文本上限为 1 MiB；请拆分过长原文');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error('读取期间资料发生变化，请明确重试');
    return decodeText(bytes);
  } finally {
    await file.close();
  }
}
export async function discoverText(
  inputs: readonly TextSource[],
  signal: AbortSignal,
  excludedDirectories: readonly string[] = [],
) {
  const documents: TextDocument[] = [];
  const ignored: string[] = [];
  let ignoredCount = 0;
  let total = 0;
  for (const raw of inputs) {
    const source = textSourceSchema.parse(raw);
    const selected = resolve(source.path);
    const root = source.type === 'directory' ? selected : dirname(selected);
    const canonical = await realpath(root);
    const walk = async (path: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (depth > 16) throw new Error('文本目录层级超过 16 层');
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error('来源不能是符号链接');
      const actual = await realpath(path);
      if (
        excludedDirectories.some((root) => {
          const part = relative(resolve(root), actual);
          return !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep);
        })
      ) {
        if (path === selected) throw new Error('内置资料和知识库自身目录不能作为用户摄入来源');
        ignoredCount++;
        if (ignored.length < 100)
          ignored.push(
            `${source.id}/${relative(canonical, actual).split(sep).join('/')}（内部资料目录）`,
          );
        return;
      }
      const part = relative(canonical, actual);
      if (isAbsolute(part) || part === '..' || part.startsWith('..' + sep))
        throw new Error('来源超出已选择目录');
      if (stat.isDirectory()) {
        if (source.type === 'file') throw new Error('file 来源不能指向目录');
        for (const name of (await readdir(path)).sort())
          if (!name.startsWith('.') && !['node_modules', 'target', 'dist'].includes(name))
            await walk(join(path, name), depth + 1);
      } else {
        if (source.type === 'directory' && path === selected)
          throw new Error('directory 来源不能指向文件');
        const name =
          relative(canonical, await realpath(path))
            .split(sep)
            .join('/') || basename(path);
        if (!isTextPath(path)) {
          if (source.type === 'file') throw new Error('只允许 .md、.markdown、.txt 文件');
          ignoredCount++;
          if (ignored.length < 100) ignored.push(`${source.id}/${name}`);
          return;
        }
        const text = await readText(path);
        if (!text.trim()) throw new Error(`原文为空：${source.id}/${name}`);
        total += Buffer.byteLength(text);
        if (documents.length >= 1000 || total > 32 * 1024 * 1024)
          throw new Error('单批来源超过 1000 份或 32 MiB');
        documents.push({
          id: sha256(JSON.stringify([source.id, name])),
          name: `${source.id}/${name}`,
          text,
          sha256: sha256(text),
        });
      }
    };
    await walk(selected, 0);
  }
  return { documents, ignored, ignoredCount, ignoredTruncated: ignoredCount > ignored.length };
}
