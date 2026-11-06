import { isAbsolute, parse } from 'node:path';
import { samFileInput, samWrites, type SamFileInput } from './contracts';
import { inspectSam } from './sam.js';
import { samProfiles } from './sam-generate.js';
import { writeSam } from './sam-write.js';

export async function executeSamFile(raw: SamFileInput, signal?: AbortSignal) {
  const request = samFileInput.parse(raw);
  let started = false;
  try {
    signal?.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(request.input)) > 16384)
      throw Object.assign(new Error('JSON 参数超过 16384 字节。'), { publicCode: 'INVALID_INPUT' });
    for (const key of ['path', 'sourcePath']) {
      const value = request.input[key];
      if (
        Object.hasOwn(request.input, key) &&
        (typeof value !== 'string' ||
          !isAbsolute(value) ||
          (process.platform === 'win32' && parse(value).root.length <= 1) ||
          !/\.(sam|smp)$/i.test(value) ||
          /[\u0000-\u001f\u007f]/.test(value))
      )
        throw Object.assign(
          new Error(`${key} 必须是执行宿主的绝对 SAM/SMP 路径，不是虚拟 shell 的路径。`),
          { publicCode: 'INVALID_INPUT' },
        );
    }
    started = true;
    const result =
      request.operation === 'profiles'
        ? await samProfiles(request.input)
        : request.operation === 'inspect' || request.operation === 'compare'
          ? await inspectSam(request.input as Parameters<typeof inspectSam>[0], request.operation)
          : await writeSam(request.input, request.operation);
    signal?.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(result)) > 60000)
      throw Object.assign(new Error('完整 SAM 回执超过 60000 字节，未返回截断内容。'), {
        publicCode: 'OUTPUT_TOO_LARGE',
      });
    return result;
  } catch (cause) {
    const error = cause as { publicCode?: string; message?: string };
    const writing = samWrites.has(request.operation);
    return {
      error: {
        code: signal?.aborted ? 'CANCELLED' : (error.publicCode ?? 'FILE_OPERATION_FAILED'),
        message: error.publicCode ? error.message : 'SAM 文件操作未确认，请核对实际路径和哈希。',
      },
      operation: request.operation,
      ...(writing
        ? {
            writeOutcome: started ? 'unknown' : 'not-started',
            targetPath: request.input.path ?? null,
            reconciliation:
              '先核对目标路径和 SHA-256，不自动重试。未指定新建路径时核对 profiles 返回的默认输出目录；取消不证明未写入或临时文件已清理。',
          }
        : {}),
    };
  }
}
