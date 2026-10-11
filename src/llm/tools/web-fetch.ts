import { lookup } from 'node:dns/promises';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { AppError } from '../../shared/types';

const MAX_BYTES = 1024 * 1024;
const MAX_CHARS = 20000;
const TIMEOUT_MS = 15000;
const redirects = new Set([301, 302, 303, 307, 308]);

export interface WebFetchResult {
  url: string;
  status: number;
  contentType: string;
  /** Untrusted remote content, never instructions or trusted application markup. */
  text: string;
  truncated: boolean;
}

interface Address {
  address: string;
  family: number;
}
export interface WebFetchDependencies {
  lookup: (hostname: string) => Promise<Address[]>;
  request: (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
  timer: (callback: () => void, milliseconds: number) => () => void;
}

function fail(code: string, message: string): AppError {
  return new AppError(code, message);
}

function publicAddress(address: string): boolean {
  if (address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99) ||
          (b === 31 && c === 196) ||
          (b === 52 && c === 193) ||
          (b === 175 && c === 48))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  // Only global unicast, excluding special-purpose, transition and documentation ranges.
  // This also excludes all IPv4-mapped, scoped, loopback, ULA and link-local addresses.
  const words = address.toLowerCase().split(':');
  const first = parseInt(words[0] || '0', 16);
  const second = parseInt(words[1] || '0', 16);
  const allocated =
    first === 0x2001 ||
    first === 0x2003 ||
    [0x2610, 0x2620].includes(first & 0xfffe) ||
    [0x2400, 0x2600, 0x2800, 0x2a00, 0x2a10, 0x2c00].includes(first & 0xfff0);
  return allocated && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
}

function parseURL(input: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(input, base) : new URL(input);
  } catch {
    throw fail('WEB_INVALID_URL', 'Invalid webpage URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw fail('WEB_INVALID_URL', 'Only credential-free HTTP and HTTPS URLs are allowed');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !hostname ||
    hostname.toLowerCase().replace(/\.$/, '') === 'localhost' ||
    hostname.toLowerCase().replace(/\.$/, '').endsWith('.localhost') ||
    (isIP(hostname) && !publicAddress(hostname))
  ) {
    throw fail('WEB_FORBIDDEN_ADDRESS', 'Only public internet addresses are allowed');
  }
  url.hash = '';
  return url;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  trade: '™',
};
function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] !== '#') return Object.hasOwn(entities, entity) ? entities[entity] : match;
    const hex = entity[1].toLowerCase() === 'x';
    const value = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value)
      : '�';
  });
}
function readableHTML(text: string): string {
  const output: string[] = [];
  const tag = /<(\/?)([a-z][a-z\d:-]*)\b/iy;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start < 0) {
      output.push(text.slice(cursor));
      break;
    }
    output.push(text.slice(cursor, start));
    if (text.startsWith('<!--', start)) {
      const end = text.indexOf('-->', start + 4);
      cursor = end < 0 ? text.length : end + 3;
      continue;
    }
    tag.lastIndex = start;
    const match = tag.exec(text);
    if (!match && !text.startsWith('<!', start) && !text.startsWith('<?', start)) {
      output.push('<');
      cursor = start + 1;
      continue;
    }
    // Scan quoted attributes once; malformed '<' runs must not cause quadratic regex work.
    let end = tag.lastIndex || start + 2;
    let quote = '';
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === text.length) break;
    cursor = end + 1;
    if (!match) continue;
    const name = match[2].toLowerCase();
    if (!match[1] && (name === 'script' || name === 'style')) {
      const close = new RegExp(`</${name}\\s*>`, 'gi');
      close.lastIndex = cursor;
      const closing = close.exec(text);
      cursor = closing ? close.lastIndex : text.length;
    } else if (
      name === 'br' ||
      name === 'hr' ||
      (match[1] && /^(?:p|div|h[1-6]|li|tr|section|article|header|footer|pre)$/.test(name))
    ) {
      output.push('\n');
    }
  }
  return decodeEntities(output.join(''))
    .replace(/[\t\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeBody(bytes: Buffer, contentType: string, truncated: boolean): string {
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset?.[1] ?? charset?.[2] ?? 'utf-8', { fatal: true });
  } catch {
    throw fail('WEB_UNSUPPORTED_ENCODING', 'Unsupported webpage character encoding');
  }
  let text: string;
  try {
    text = decoder.decode(bytes, { stream: truncated });
  } catch {
    throw fail('WEB_INVALID_TEXT', 'Webpage does not contain valid text');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
    throw fail('WEB_INVALID_TEXT', 'Binary webpage content is not supported');
  }
  return contentType.split(';')[0].trim().toLowerCase() === 'text/html' ? readableHTML(text) : text;
}

/** The injectable factory is for offline tests; fetchWeb always uses the native transports. */
export function createWebFetcher(overrides: Partial<WebFetchDependencies> = {}) {
  const dependencies: WebFetchDependencies = {
    lookup: (hostname) => lookup(hostname, { all: true, verbatim: true }),
    request: (url, options, callback) =>
      (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, callback),
    timer: (callback, milliseconds) => {
      const timer = setTimeout(callback, milliseconds);
      return () => clearTimeout(timer);
    },
    ...overrides,
  };

  return async (input: string, caller: AbortSignal): Promise<WebFetchResult> => {
    const deadline = Date.now() + TIMEOUT_MS;
    const controller = new AbortController();
    const signal = controller.signal;
    const checkAbort = () => {
      if (!signal.aborted && Date.now() >= deadline) {
        controller.abort(fail('WEB_TIMEOUT', 'Webpage fetch timed out'));
      }
      if (signal.aborted) throw signal.reason;
    };
    const abort = () => controller.abort(fail('WEB_ABORTED', 'Webpage fetch cancelled'));
    caller.addEventListener('abort', abort, { once: true });
    if (caller.aborted) abort();
    const cancelTimer = dependencies.timer(
      () => controller.abort(fail('WEB_TIMEOUT', 'Webpage fetch timed out')),
      TIMEOUT_MS,
    );
    try {
      let url = parseURL(input);
      for (let count = 0; ; count++) {
        checkAbort();
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        let addresses: Address[];
        try {
          addresses = isIP(hostname)
            ? [{ address: hostname, family: isIP(hostname) }]
            : await abortable(dependencies.lookup(hostname), signal);
        } catch {
          if (signal.aborted) throw signal.reason;
          throw fail('WEB_DNS_FAILED', 'Could not resolve webpage host');
        }
        if (!addresses.length) throw fail('WEB_DNS_FAILED', 'Could not resolve webpage host');
        if (
          addresses.some(
            ({ address, family }) => !publicAddress(address) || isIP(address) !== family,
          )
        ) {
          throw fail('WEB_FORBIDDEN_ADDRESS', 'Only public internet addresses are allowed');
        }
        checkAbort();
        const pinned = addresses[0];
        const options: RequestOptions = {
          agent: false,
          headers: {
            Accept: 'text/html, text/plain, application/json, text/*;q=0.9',
            'Accept-Encoding': 'identity',
          },
          // Keep the URL hostname for Host, SNI and certificate verification. Only DNS is replaced.
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
          ...(url.protocol === 'https:'
            ? { rejectUnauthorized: true, servername: isIP(hostname) ? '' : hostname }
            : {}),
        };
        const response = await new Promise<{ location: string } | WebFetchResult>(
          (resolve, reject) => {
            let request: ClientRequest | undefined;
            let incoming: IncomingMessage | undefined;
            let settled = false;
            let cleanupBody = () => {};
            const finish = (error?: AppError, result?: { location: string } | WebFetchResult) => {
              if (settled) return;
              settled = true;
              signal.removeEventListener('abort', onAbort);
              cleanupBody();
              if (error) reject(error);
              else resolve(result!);
              incoming?.destroy();
              request?.destroy();
            };
            const onAbort = () => finish(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) {
              onAbort();
              return;
            }
            try {
              request = dependencies.request(url, options, (res) => {
                const responseError = () =>
                  finish(fail('WEB_NETWORK_FAILED', 'Could not read webpage response'));
                // Destruction may emit a queued socket error; retain its handler until close.
                res.on('error', responseError);
                res.once('close', () => res.removeListener('error', responseError));
                if (settled) {
                  res.destroy();
                  return;
                }
                incoming = res;
                const status = res.statusCode ?? 0;
                if (redirects.has(status)) {
                  const location = res.headers.location;
                  if (!location)
                    finish(fail('WEB_INVALID_REDIRECT', 'Webpage redirect has no destination'));
                  else finish(undefined, { location });
                  return;
                }
                const contentType = res.headers['content-type'] ?? '';
                const mime = contentType.split(';')[0].trim().toLowerCase();
                if (
                  !/^text\/[\w!#$&^.+-]+$/.test(mime) &&
                  mime !== 'application/json' &&
                  !/^application\/[\w.+-]+\+json$/.test(mime)
                ) {
                  finish(fail('WEB_UNSUPPORTED_CONTENT', 'Unsupported webpage content type'));
                  return;
                }
                const encoding = res.headers['content-encoding'];
                if (encoding && encoding.trim().toLowerCase() !== 'identity') {
                  finish(
                    fail('WEB_UNSUPPORTED_ENCODING', 'Compressed webpage content is not supported'),
                  );
                  return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                const complete = (truncated: boolean) => {
                  try {
                    const text = decodeBody(Buffer.concat(chunks, size), contentType, truncated);
                    let output = text.slice(0, MAX_CHARS);
                    if (output.length && /[\ud800-\udbff]/.test(output.at(-1)!))
                      output = output.slice(0, -1);
                    finish(undefined, {
                      url: url.href,
                      status,
                      contentType,
                      text: output,
                      truncated: truncated || text.length > MAX_CHARS,
                    });
                  } catch (error) {
                    finish(
                      error instanceof AppError
                        ? error
                        : fail('WEB_INVALID_TEXT', 'Could not read webpage text'),
                    );
                  }
                };
                const data = (chunk: Buffer) => {
                  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                  const remaining = MAX_BYTES - size;
                  chunks.push(bytes.subarray(0, remaining));
                  size += Math.min(bytes.length, remaining);
                  if (size === MAX_BYTES) complete(true);
                };
                const end = () => complete(false);
                const error = responseError;
                const close = () => {
                  if (!res.complete) error();
                };
                cleanupBody = () => {
                  res.removeListener('data', data);
                  res.removeListener('end', end);
                  res.removeListener('aborted', error);
                  res.removeListener('close', close);
                };
                res.on('data', data);
                res.once('end', end);
                res.once('aborted', error);
                res.once('close', close);
              });
              const requestError = () =>
                finish(fail('WEB_NETWORK_FAILED', 'Could not fetch webpage'));
              request.on('error', requestError);
              request.once('close', () => request?.removeListener('error', requestError));
              if (settled) request.destroy();
              else request.end();
            } catch {
              finish(fail('WEB_NETWORK_FAILED', 'Could not fetch webpage'));
            }
          },
        );
        checkAbort();
        if ('location' in response) {
          if (count >= 3) throw fail('WEB_REDIRECT_LIMIT', 'Too many webpage redirects');
          url = parseURL(response.location, url);
        } else return response;
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof AppError) throw error;
      throw fail('WEB_NETWORK_FAILED', 'Could not fetch webpage');
    } finally {
      cancelTimer();
      caller.removeEventListener('abort', abort);
    }
  };
}

const nativeFetch = createWebFetcher();

/** Fetch at most 1 MiB, with a single 15-second deadline and at most three redirects. */
export async function fetchWeb(url: string, signal: AbortSignal): Promise<WebFetchResult> {
  return nativeFetch(url, signal);
}
