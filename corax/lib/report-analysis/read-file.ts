import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export async function readLocalFile(path: string, extension: string, limit: number) {
  if (!isAbsolute(path) || !path.toLowerCase().endsWith(extension)) {
    throw new Error(`请提供本机 ${extension} 文件的绝对路径。`);
  }
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      throw new Error('文件为空、过大或不是普通文件。');
    const data = new Uint8Array(stat.size);
    for (let offset = 0; offset < data.length;) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) throw new Error('读取时文件发生变化，请重新选择报告或模型。');
      offset += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error('读取时文件发生变化，请重新选择报告或模型。');
    return data;
  } finally {
    await file.close();
  }
}
