import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createServer,
  request as nativeRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppError } from '../../src/shared/types';
import { createWebFetcher, type WebFetchDependencies } from '../../src/tool/tools/web-fetch';

type Reply = {
  status?: number;
  headers?: IncomingMessage['headers'];
  chunks?: (Buffer | string)[];
  hang?: boolean;
  error?: boolean;
};
function fixture(
  replies: Reply[] = [{}],
  overrides: Partial<WebFetchDependencies> = {},
  format: { rawHTML?: boolean } = {},
) {
  const requests: {
    url: URL;
    options: RequestOptions;
    request: ClientRequest;
    response?: IncomingMessage;
  }[] = [];
  const resolutions: string[] = [];
  let deadline: () => void = () => {};
  let timerCleaned = false;
  const fetch = createWebFetcher(
    {
      lookup: async (hostname) => {
        resolutions.push(hostname);
        return [{ address: '93.184.216.34', family: 4 }];
      },
      timer: (callback, milliseconds) => {
        expect(milliseconds).toBe(15000);
        deadline = callback;
        return () => {
          timerCleaned = true;
        };
      },
      request: (url, options, callback) => {
        const reply = replies[requests.length] ?? {};
        const emitter = new EventEmitter();
        const request = Object.assign(emitter, {
          destroyed: false,
          destroy() {
            if (!this.destroyed) {
              this.destroyed = true;
              queueMicrotask(() => emitter.emit('close'));
            }
            return this;
          },
          end() {
            queueMicrotask(() => {
              if (request.destroyed) return;
              if (reply.error) {
                emitter.emit('error', new Error('SECRET network details'));
                return;
              }
              const response = Object.assign(new PassThrough(), {
                statusCode: reply.status ?? 200,
                headers: reply.headers ?? { 'content-type': 'text/plain; charset=utf-8' },
                complete: false,
              }) as unknown as IncomingMessage;
              record.response = response;
              callback(response);
              queueMicrotask(() => {
                if (response.destroyed || reply.hang) return;
                for (const chunk of reply.chunks ?? ['hello']) {
                  if (response.destroyed) return;
                  response.push(Buffer.from(chunk));
                }
                response.complete = true;
                response.push(null);
              });
            });
            return this;
          },
        }) as unknown as ClientRequest;
        const record = {
          url,
          options,
          request,
          response: undefined as IncomingMessage | undefined,
        };
        requests.push(record);
        return request;
      },
      ...overrides,
    },
    format,
  );
  const signal = new AbortController().signal;
  return {
    fetch,
    signal,
    requests,
    resolutions,
    expire: () => deadline(),
    cleaned: () => timerCleaned,
  };
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error('Expected fetch to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('internal HTML mode preserves markup beyond the public text cap', async () => {
  const html = `<html><body><a href="https://example.com">${'x'.repeat(25000)}</a></body></html>`;
  const replies = [{ headers: { 'content-type': 'text/html' }, chunks: [html] }];
  const raw = fixture(replies, {}, { rawHTML: true });
  expect(await raw.fetch('https://example.com', raw.signal)).toMatchObject({
    text: html,
    truncated: false,
  });
  const text = fixture(replies);
  expect(await text.fetch('https://example.com', text.signal)).toMatchObject({
    text: 'x'.repeat(20000),
    truncated: true,
  });
});

test('internal HTML mode still caps bytes and rejects private DNS destinations', async () => {
  const raw = fixture(
    [{ headers: { 'content-type': 'text/html' }, chunks: ['<html>' + 'x'.repeat(1024 * 1024)] }],
    {},
    { rawHTML: true },
  );
  const result = await raw.fetch('https://example.com', raw.signal);
  expect(Buffer.byteLength(result.text)).toBe(1024 * 1024);
  expect(result.truncated).toBe(true);
  const denied = fixture(
    [],
    { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
    { rawHTML: true },
  );
  await rejectsCode(denied.fetch('https://example.com', denied.signal), 'WEB_FORBIDDEN_ADDRESS');
  expect(denied.requests).toHaveLength(0);
});

test('configured private-address access covers literals, DNS, IPv6 and redirects without leaking across calls', async () => {
  const policy = { allowPrivateAddresses: true };
  for (const url of [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://198.18.0.23/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost/',
  ]) {
    const f = fixture();
    expect((await f.fetch(url, f.signal, policy)).text).toBe('hello');
    expect(f.requests).toHaveLength(1);
    await rejectsCode(
      f.fetch(url, f.signal, { allowPrivateAddresses: false }),
      'WEB_FORBIDDEN_ADDRESS',
    );
    expect(f.requests).toHaveLength(1);
  }
  for (const address of ['10.0.0.1', '198.18.0.23', 'fd00::1']) {
    const f = fixture([], {
      lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
    });
    expect((await f.fetch('https://example.com/', f.signal, policy)).text).toBe('hello');
    await rejectsCode(f.fetch('https://example.com/', f.signal), 'WEB_FORBIDDEN_ADDRESS');
  }
  const redirects = [{ status: 302, headers: { location: 'http://127.0.0.1/page' } }, {}];
  const allowed = fixture(redirects);
  expect((await allowed.fetch('https://example.com/', allowed.signal, policy)).url).toBe(
    'http://127.0.0.1/page',
  );
  expect(allowed.requests).toHaveLength(2);
  const denied = fixture(redirects);
  await rejectsCode(
    denied.fetch('https://example.com/', denied.signal, { allowPrivateAddresses: false }),
    'WEB_FORBIDDEN_ADDRESS',
  );
  expect(denied.requests).toHaveLength(1);
});

test('private-address access retains protocol, credential and DNS syntax checks', async () => {
  for (const url of ['file:///secret', 'ftp://localhost/', 'http://user:password@localhost/']) {
    const f = fixture();
    await rejectsCode(f.fetch(url, f.signal, { allowPrivateAddresses: true }), 'WEB_INVALID_URL');
    expect(f.requests).toHaveLength(0);
  }
  for (const address of [
    { address: 'not-an-IP', family: 4 },
    { address: '10.0.0.1', family: 6 },
  ]) {
    const f = fixture([], { lookup: async () => [address] });
    await rejectsCode(
      f.fetch('https://example.com/', f.signal, { allowPrivateAddresses: true }),
      'WEB_FORBIDDEN_ADDRESS',
    );
    expect(f.requests).toHaveLength(0);
  }
});

test('Fake-IP DNS gets actionable guidance without allowing a connection', async () => {
  for (const address of ['198.18.1.142', '198.19.0.4']) {
    const f = fixture([], { lookup: async () => [{ address, family: 4 }] });
    await expect(f.fetch('https://example.com', f.signal)).rejects.toThrow('redir-host');
    expect(f.requests).toHaveLength(0);
  }
  const literal = fixture();
  await expect(literal.fetch('http://198.18.0.4', literal.signal)).rejects.toThrow('Only public');
  expect(literal.resolutions).toHaveLength(0);
});

describe('web fetch public internet boundary', () => {
  test.each([
    'http://localhost/',
    'http://LOCALHOST./',
    'http://a.localhost/',
    'http://127.0.0.1/',
    'http://127.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0.0.0.0/',
    'http://10.2.3.4/',
    'http://100.64.0.1/',
    'http://100.127.255.255/',
    'http://169.254.169.254/',
    'http://172.16.1.1/',
    'http://172.31.255.255/',
    'http://192.168.0.1/',
    'http://192.0.0.1/',
    'http://192.0.2.1/',
    'http://192.88.99.1/',
    'http://198.18.0.1/',
    'http://198.19.255.255/',
    'http://198.51.100.1/',
    'http://203.0.113.1/',
    'http://224.0.0.1/',
    'http://240.0.0.1/',
    'http://255.255.255.255/',
    'http://[::]/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fd12::1]/',
    'http://[fe80::1]/',
    'http://[fec0::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:8.8.8.8]/',
    'http://[64:ff9b::a00:1]/',
    'http://[2001:db8::1]/',
    'http://[2001::1]/',
    'http://[2001:20::1]/',
    'http://[2002:7f00:1::]/',
    'http://[3fff::1]/',
    'http://[3ffe::1]/',
  ])('rejects forbidden literal %s before transport', async (url) => {
    const f = fixture();
    await rejectsCode(f.fetch(url, f.signal), 'WEB_FORBIDDEN_ADDRESS');
    expect(f.requests).toHaveLength(0);
    expect(f.cleaned()).toBe(true);
  });

  test.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'not a URL',
    'https://user:pass@example.com/',
    'http://user@example.com/',
    'http://[fe80::1%25eth0]/',
  ])('rejects invalid URL %s', async (url) => {
    const f = fixture();
    await rejectsCode(f.fetch(url, f.signal), 'WEB_INVALID_URL');
    expect(f.requests).toHaveLength(0);
  });

  test.each(['127.0.0.1', '10.0.0.1', '::ffff:127.0.0.1', 'fe80::1', '2001:db8::1', 'garbage'])(
    'rejects private or mixed DNS answer %s',
    async (address) => {
      const f = fixture([], {
        lookup: async () => [
          { address: '8.8.8.8', family: 4 },
          { address, family: address.includes(':') ? 6 : 4 },
        ],
      });
      await rejectsCode(f.fetch('https://example.com', f.signal), 'WEB_FORBIDDEN_ADDRESS');
      expect(f.requests).toHaveLength(0);
    },
  );

  test('pins approved DNS addresses without changing Host or TLS hostname', async () => {
    let calls = 0;
    const f = fixture([{}], {
      lookup: async () => {
        calls++;
        return calls === 1
          ? [{ address: '2606:4700:4700::1111', family: 6 }]
          : [{ address: '127.0.0.1', family: 4 }];
      },
    });
    await f.fetch('https://example.com/path#fragment', f.signal);
    expect(calls).toBe(1);
    const { url, options } = f.requests[0];
    expect(url.hostname).toBe('example.com');
    expect(url.hash).toBe('');
    expect(options.agent).toBe(false);
    expect(options).toMatchObject({ servername: 'example.com', rejectUnauthorized: true });
    expect(options.headers).toEqual({
      Accept: 'text/html, text/plain, application/json, text/*;q=0.9',
      'Accept-Encoding': 'identity',
    });
    const lookup = options.lookup!;
    lookup('example.com', { family: 0 }, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe('2606:4700:4700::1111');
      expect(family).toBe(6);
    });
    lookup('example.com', { all: true }, (error, addresses) => {
      expect(error).toBeNull();
      expect(addresses).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]);
    });
    expect(calls).toBe(1);
  });

  test.each(['http://8.8.8.8/', 'https://[2606:4700:4700::1111]/'])(
    'allows public literal %s without DNS',
    async (url) => {
      const f = fixture();
      expect((await f.fetch(url, f.signal)).text).toBe('hello');
      expect(f.resolutions).toEqual([]);
    },
  );

  test.each([
    'http://127.0.0.1/',
    '//localhost/',
    'file:///secret',
    'https://user:pass@example.com/',
  ])('validates redirect %s before connecting', async (location) => {
    const f = fixture([{ status: 302, headers: { location } }]);
    await expect(f.fetch('https://example.com/', f.signal)).rejects.toBeInstanceOf(AppError);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].response?.destroyed).toBe(true);
  });

  test('revalidates DNS on same-host redirects and rejects rebinding', async () => {
    let calls = 0;
    const f = fixture([{ status: 307, headers: { location: '/next' } }], {
      lookup: async () => [{ address: ++calls === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }],
    });
    await rejectsCode(f.fetch('https://example.com', f.signal), 'WEB_FORBIDDEN_ADDRESS');
    expect(calls).toBe(2);
    expect(f.requests).toHaveLength(1);
  });

  test('follows up to three redirects including relative destinations', async () => {
    const f = fixture([
      { status: 301, headers: { location: '/two' } },
      { status: 303, headers: { location: 'https://other.example/three' } },
      { status: 308, headers: { location: '?final=1' } },
      { status: 404, chunks: ['not found'] },
    ]);
    expect(await f.fetch('http://example.com/', f.signal)).toMatchObject({
      url: 'https://other.example/three?final=1',
      status: 404,
      text: 'not found',
    });
    expect(f.requests).toHaveLength(4);
    expect(f.resolutions).toEqual(['example.com', 'example.com', 'other.example', 'other.example']);
  });

  test('rejects fourth redirect and missing destination', async () => {
    const f = fixture(
      Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/' } })),
    );
    await rejectsCode(f.fetch('https://example.com', f.signal), 'WEB_REDIRECT_LIMIT');
    expect(f.requests).toHaveLength(4);
    const missing = fixture([{ status: 302, headers: {} }]);
    await rejectsCode(missing.fetch('https://example.com', missing.signal), 'WEB_INVALID_REDIRECT');
  });
});

test('Bun native transport consumes pinned lookup (loopback-only test adapter)', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('native transport');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  let pinnedCalls = 0;
  const f = fixture([], {
    request: (_url, options, callback) =>
      nativeRequest(
        {
          ...options,
          hostname: 'localhost',
          port,
          lookup: (hostname, lookupOptions, done) => {
            options.lookup!(hostname, lookupOptions, (error, addresses) => {
              expect(error).toBeNull();
              expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
              pinnedCalls++;
              // Only this test transport maps the approved address to the local server.
              if (lookupOptions.all) done(null, [{ address: '127.0.0.1', family: 4 }]);
              else done(null, '127.0.0.1', 4);
            });
          },
        },
        callback,
      ),
  });
  try {
    expect((await f.fetch('http://example.com/', f.signal)).text).toBe('native transport');
    expect(pinnedCalls).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe('web fetch text and lifecycle', () => {
  test('quoted attributes, incomplete raw elements, and malformed tag runs stay readable', async () => {
    const f = fixture([
      {
        headers: { 'content-type': 'text/html' },
        chunks: ['<p title="a > b">visible</p><script title=">">secret</script><style>hidden'],
      },
    ]);
    expect((await f.fetch('https://example.com', f.signal)).text).toBe('visible');
    const malformed = fixture([
      { headers: { 'content-type': 'text/html' }, chunks: ['<'.repeat(200000)] },
    ]);
    const result = await malformed.fetch('https://example.com', malformed.signal);
    expect(result.text).toBe('<'.repeat(20000));
    expect(result.truncated).toBe(true);
  });

  test('abort before response headers destroys the request and cleans caller listeners', async () => {
    const controller = new AbortController();
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    let listeners = 0;
    controller.signal.addEventListener = (...args: Parameters<typeof add>) => {
      listeners++;
      add(...args);
    };
    controller.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      listeners--;
      remove(...args);
    };
    const request = Object.assign(new EventEmitter(), {
      destroyed: false,
      end() {},
      destroy() {
        this.destroyed = true;
        return this;
      },
    }) as unknown as ClientRequest;
    let respond!: (response: IncomingMessage) => void;
    const f = fixture([], {
      request: (_url, _options, callback) => {
        respond = callback;
        return request;
      },
    });
    const pending = f.fetch('https://example.com', controller.signal);
    await tick();
    controller.abort();
    await rejectsCode(pending, 'WEB_ABORTED');
    expect(request.destroyed).toBe(true);
    expect(listeners).toBe(0);
    const late = new PassThrough() as unknown as IncomingMessage;
    respond(late);
    expect(late.destroyed).toBe(true);
  });

  test('extracts HTML without scripts, styles, comments and decodes entities', async () => {
    const f = fixture([
      {
        headers: { 'content-type': 'text/html; charset=UTF-8' },
        chunks: [
          '<!-- hidden --><style>secret</style><script>evil()</script><h1>Hello &amp; world</h1><p>&lt;safe&gt; &quot; &#39; &#x1f600; &nbsp; &copy;</p><br><p>Next</p>',
        ],
      },
    ]);
    const result = await f.fetch('https://example.com', f.signal);
    expect(result.text).toBe('Hello & world\n<safe> " \' 😀 ©\n\nNext');
    expect(result.truncated).toBe(false);
    expect(f.cleaned()).toBe(true);
  });

  test.each([
    'text/plain',
    'text/csv',
    'application/json',
    'application/problem+json',
    'TEXT/PLAIN; charset="utf-8"',
  ])('accepts %s as text', async (contentType) => {
    const f = fixture([
      { headers: { 'content-type': contentType }, chunks: ['{"value":"&amp;"}'] },
    ]);
    expect((await f.fetch('http://example.com', f.signal)).text).toBe('{"value":"&amp;"}');
  });

  test.each(['image/png', 'application/octet-stream', 'application/pdf', ''])(
    'rejects unsupported type %s',
    async (contentType) => {
      const f = fixture([{ headers: { 'content-type': contentType } }]);
      await rejectsCode(f.fetch('http://example.com', f.signal), 'WEB_UNSUPPORTED_CONTENT');
      expect(f.requests[0].request.destroyed).toBe(true);
      expect(f.requests[0].response?.destroyed).toBe(true);
    },
  );

  test.each(['gzip', 'br', 'deflate', 'identity, gzip'])(
    'rejects compression %s',
    async (encoding) => {
      const f = fixture([
        { headers: { 'content-type': 'text/plain', 'content-encoding': encoding } },
      ]);
      await rejectsCode(f.fetch('http://example.com', f.signal), 'WEB_UNSUPPORTED_ENCODING');
    },
  );

  test('rejects invalid charset, binary data, and malformed UTF-8', async () => {
    for (const reply of [
      { headers: { 'content-type': 'text/plain; charset=not-real' }, chunks: ['hi'] },
      { chunks: [Buffer.from([0, 1, 2])] },
      { chunks: [Buffer.from([0xff])] },
    ]) {
      const f = fixture([reply]);
      await rejectsCode(
        f.fetch('http://example.com', f.signal),
        reply.headers ? 'WEB_UNSUPPORTED_ENCODING' : 'WEB_INVALID_TEXT',
      );
    }
  });

  test('limits output characters and avoids splitting surrogate pairs', async () => {
    const f = fixture([{ chunks: ['a'.repeat(19999) + '😀tail'] }]);
    const result = await f.fetch('https://example.com', f.signal);
    expect(result.text).toBe('a'.repeat(19999));
    expect(result.truncated).toBe(true);
  });

  test('stops at 1 MiB bytes regardless of content length or chunk boundaries', async () => {
    const f = fixture([
      {
        headers: { 'content-type': 'text/html', 'content-length': '1' },
        chunks: ['<!--', 'a'.repeat(1024 * 1024), '--><p>not reached</p>'],
      },
    ]);
    const result = await f.fetch('https://example.com', f.signal);
    expect(result.text).toBe('');
    expect(result.truncated).toBe(true);
    expect(f.requests[0].response?.destroyed).toBe(true);
  });

  test('handles exact byte and character limits and incomplete UTF-8 at truncation', async () => {
    const exact = fixture([{ chunks: ['x'.repeat(20000)] }]);
    expect((await exact.fetch('https://example.com', exact.signal)).truncated).toBe(false);
    const bytes = fixture([
      { headers: { 'content-type': 'text/html' }, chunks: ['<!--' + 'x'.repeat(1024 * 1024 - 4)] },
    ]);
    expect((await bytes.fetch('https://example.com', bytes.signal)).truncated).toBe(true);
    const split = fixture([
      { chunks: [Buffer.concat([Buffer.alloc(1024 * 1024 - 1, 97), Buffer.from('😀')])] },
    ]);
    expect((await split.fetch('https://example.com', split.signal)).truncated).toBe(true);
  });

  test('pre-abort makes no DNS or request and hides caller reasons', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error('SECRET'));
    await rejectsCode(f.fetch('https://example.com', controller.signal), 'WEB_ABORTED');
    expect(f.resolutions).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
    expect(f.cleaned()).toBe(true);
  });

  test('abort racing DNS startup consumes a late DNS rejection', async () => {
    const controller = new AbortController();
    const f = fixture([], {
      lookup: () => {
        controller.abort();
        return Promise.reject(new Error('SECRET late DNS failure'));
      },
    });
    await rejectsCode(f.fetch('https://example.com', controller.signal), 'WEB_ABORTED');
    await tick();
    expect(f.requests).toHaveLength(0);
    expect(f.cleaned()).toBe(true);
  });

  test.each(['abort', 'timeout'])(
    '%s during DNS returns promptly and never connects later',
    async (mode) => {
      let resolve!: (value: { address: string; family: number }[]) => void;
      const f = fixture([], {
        lookup: () =>
          new Promise((r) => {
            resolve = r;
          }),
      });
      const controller = new AbortController();
      const pending = f.fetch('https://example.com', controller.signal);
      if (mode === 'abort') controller.abort();
      else f.expire();
      await rejectsCode(pending, mode === 'abort' ? 'WEB_ABORTED' : 'WEB_TIMEOUT');
      resolve([{ address: '8.8.8.8', family: 4 }]);
      await tick();
      expect(f.requests).toHaveLength(0);
      expect(f.cleaned()).toBe(true);
    },
  );

  test.each(['abort', 'timeout'])(
    '%s destroys active body streams and removes listeners',
    async (mode) => {
      const f = fixture([{ hang: true }]);
      const controller = new AbortController();
      const pending = f.fetch('https://example.com', controller.signal);
      await tick();
      if (mode === 'abort') controller.abort();
      else f.expire();
      await rejectsCode(pending, mode === 'abort' ? 'WEB_ABORTED' : 'WEB_TIMEOUT');
      expect(f.requests[0].request.destroyed).toBe(true);
      expect(f.requests[0].response?.destroyed).toBe(true);
      expect(f.requests[0].response?.listenerCount('data')).toBe(0);
      expect(f.cleaned()).toBe(true);
    },
  );

  test('timeout spans redirects rather than resetting on each request', async () => {
    let timers = 0;
    let deadline!: () => void;
    const f = fixture([{ status: 302, headers: { location: '/next' } }, { hang: true }], {
      timer: (callback) => {
        timers++;
        deadline = callback;
        return () => {};
      },
    });
    const pending = f.fetch('https://example.com', f.signal);
    await tick();
    deadline();
    await rejectsCode(pending, 'WEB_TIMEOUT');
    expect(timers).toBe(1);
    expect(f.requests).toHaveLength(2);
  });

  test('sanitizes DNS and request failures', async () => {
    const dns = fixture([], {
      lookup: async () => {
        throw new Error('SECRET DNS');
      },
    });
    await rejectsCode(dns.fetch('https://example.com', dns.signal), 'WEB_DNS_FAILED');
    const empty = fixture([], { lookup: async () => [] });
    await rejectsCode(empty.fetch('https://example.com', empty.signal), 'WEB_DNS_FAILED');
    const network = fixture([{ error: true }]);
    await rejectsCode(network.fetch('https://example.com', network.signal), 'WEB_NETWORK_FAILED');
    try {
      await network.fetch('https://example.com', network.signal);
    } catch (error) {
      expect((error as Error).message).not.toContain('SECRET');
    }
  });

  test('rejects prematurely closed and errored response streams', async () => {
    for (const mode of ['close', 'error']) {
      const f = fixture([{ hang: true }]);
      const pending = f.fetch('https://example.com', f.signal);
      await tick();
      const res = f.requests[0].response!;
      if (mode === 'close') res.destroy();
      else res.emit('error', new Error('SECRET'));
      await rejectsCode(pending, 'WEB_NETWORK_FAILED');
      expect(f.cleaned()).toBe(true);
    }
  });
});
