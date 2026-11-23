import { get as getHttp, type IncomingMessage } from 'node:http';
import { get as getHttps } from 'node:https';

function imageUrl(value: string | URL) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('请提供不含用户名或密码的 HTTP 或 HTTPS 图片地址。');
  return url;
}

export async function downloadChatImage(value: string, maxBytes: number, signal?: AbortSignal) {
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  let url = imageUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const get = url.protocol === 'https:' ? getHttps : getHttp;
      get(
        url,
        {
          agent: false,
          signal: deadline,
          headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm' },
        },
        resolve,
      ).once('error', reject);
    });
    try {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        const next = imageUrl(new URL(response.headers.location, url));
        if (next.origin !== url.origin) throw new Error('附件地址跳转到其他来源。');
        url = next;
        continue;
      }
      if (status !== 200) throw new Error(`图片下载失败（HTTP ${status}）。`);
      const type = response.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
      if (
        type &&
        type !== 'application/octet-stream' &&
        !/^(?:image\/(png|jpeg|gif|webp)|video\/(mp4|webm))$/.test(type)
      ) {
        throw new Error('URL 未返回支持的图片格式。');
      }
      if (Number(response.headers['content-length']) > maxBytes)
        throw new Error('图片超过 8 MiB。');
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of response) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > maxBytes) throw new Error('图片超过 8 MiB。');
        chunks.push(bytes);
      }
      return {
        bytes: Buffer.concat(chunks, length),
        mediaType: type === 'application/octet-stream' ? undefined : type,
      };
    } finally {
      response.destroy();
    }
  }
  throw new Error('图片 URL 重定向次数过多。');
}
