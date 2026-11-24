import { constants } from 'node:fs';
import { link, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { imageSize } from 'image-size';
import type { ChatMedia } from '@auto-agent/desktop-protocol';
import { downloadMedia } from './download';

const maxBytes = 8 * 1024 * 1024;
const localPath = (path: string) =>
  isAbsolute(path) && (process.platform !== 'win32' || /^[a-z]:[\\/][^:]*$/i.test(path));

async function readLocalMedia(path: string, size: number) {
  if (!localPath(path) || size > maxBytes) throw new Error('附件不可预览。');
  const resolved = await realpath(path);
  if (!localPath(resolved)) throw new Error('附件不可预览。');
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== size) throw new Error('原文件已改变。');
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (!bytesRead) throw new Error('附件读取不完整。');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== size || after.mtimeMs !== stat.mtimeMs) throw new Error('原文件已改变。');
    return bytes;
  } finally {
    await handle.close();
  }
}

type LocalMedia = Extract<ChatMedia, { kind: 'file' }>;

function assertMediaBytes(media: ChatMedia, bytes: Buffer) {
  const { mediaType } = media;
  if (mediaType.startsWith('image/')) {
    const { type, width, height } = imageSize(bytes);
    const actual = type === 'jpg' ? 'image/jpeg' : `image/${type}`;
    if (
      actual !== mediaType ||
      !width ||
      !height ||
      width > 8192 ||
      height > 8192 ||
      width * height > 16_000_000 ||
      (media.width !== undefined && media.width !== width) ||
      (media.height !== undefined && media.height !== height)
    ) {
      throw new Error('图片类型或尺寸不匹配。');
    }
  } else if (
    mediaType === 'video/mp4'
      ? bytes.toString('ascii', 4, 8) !== 'ftyp'
      : bytes.subarray(0, 4).toString('hex') !== '1a45dfa3'
  ) {
    throw new Error('视频格式不匹配。');
  }
}

function snapshotPath(dataDir: string, id: string) {
  return join(dataDir, 'chat-media', createHash('sha256').update(id).digest('hex'));
}

export async function snapshotChatMedia(dataDir: string, id: string, media: LocalMedia) {
  const bytes = await readLocalMedia(media.path, media.size);
  assertMediaBytes(media, bytes);
  const target = snapshotPath(dataDir, id);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    // Publish atomically without replacing an existing snapshot after hook replay.
    await link(temporary, target).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readChatMedia(
  media: Exclude<ChatMedia, { kind: 'data' }>,
  options: { dataDir: string; id: string; signal?: AbortSignal },
) {
  const bytes =
    media.kind === 'file'
      ? await readLocalMedia(snapshotPath(options.dataDir, options.id), media.size)
      : (await downloadMedia(media.url, maxBytes, options.signal)).bytes;
  assertMediaBytes(media, bytes);
  return { mediaType: media.mediaType, base64: bytes.toString('base64') };
}
