import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { AppError } from '../../src/shared/types';
import { createWebSearcher } from '../../src/tool/tools/web-search';
import { createWebFetcher, type WebFetchResult } from '../../src/tool/tools/web-fetch';

const signal = () => new AbortController().signal;
const entry = (
  url = 'https://fictional.example/page',
  title = 'Fictional title',
  text = 'Fictional snippet',
) => `Title: ${title}\nURL: ${url}\nText: ${text}`;
const reply = (text: string) => ({
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text }] },
});
function fixture(value: unknown = reply(entry()), overrides: Partial<WebFetchResult> = {}) {
  const calls: { body: string; signal: AbortSignal; policy: unknown }[] = [];
  const search = createWebSearcher({
    request: async (body, signal, policy) => {
      calls.push({ body, signal, policy });
      return {
        url: 'https://mcp.exa.ai/mcp',
        status: 200,
        contentType: 'application/json',
        text: JSON.stringify(value),
        truncated: false,
        ...overrides,
      };
    },
  });
  return { search, calls };
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('Exa MCP search', () => {
  test('sends the OpenCode Exa tools/call contract and preserves the caller policy', async () => {
    const f = fixture();
    const s = signal();
    const output = await f.search('  石墨烯 & %26  ', 3, s, { allowPrivateAddresses: true });
    expect(JSON.parse(f.calls[0].body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'web_search_exa', arguments: { query: '石墨烯 & %26', numResults: 3 } },
    });
    expect(f.calls[0].signal).toBe(s);
    expect(f.calls[0].policy).toEqual({ allowPrivateAddresses: true });
    expect(output).toMatchObject({
      query: '石墨烯 & %26',
      provider: 'exa',
      status: 'results',
      truncated: false,
    });
    expect(output.results).toEqual([
      {
        title: 'Fictional title',
        url: 'https://fictional.example/page',
        snippet: 'Fictional snippet',
      },
    ]);
  });

  test('uses the optional Exa key without leaking it into the query or results', async () => {
    const previous = process.env.EXA_API_KEY;
    const endpoints: string[] = [];
    const bodies: string[] = [];
    const search = createWebSearcher({
      request: async (body, _signal, _policy, endpoint) => {
        endpoints.push(endpoint);
        bodies.push(body);
        return {
          url: endpoint,
          status: 200,
          contentType: 'application/json',
          text: JSON.stringify(reply(entry())),
          truncated: false,
        };
      },
    });
    try {
      delete process.env.EXA_API_KEY;
      await search('public', 5, signal());
      expect(endpoints[0]).toBe('https://mcp.exa.ai/mcp');
      process.env.EXA_API_KEY = '  fixture-key+&?  ';
      const result = await search('public', 5, signal());
      expect(new URL(endpoints[1]).searchParams.get('exaApiKey')).toBe('fixture-key+&?');
      expect(bodies[1]).not.toContain('fixture-key');
      expect(JSON.stringify(result)).not.toContain('fixture-key');
      process.env.EXA_API_KEY = ' ';
      await search('public', 5, signal());
      expect(endpoints[2]).toBe('https://mcp.exa.ai/mcp');
    } finally {
      if (previous === undefined) delete process.env.EXA_API_KEY;
      else process.env.EXA_API_KEY = previous;
    }
  });

  test('rejects invalid inputs before transport', async () => {
    const f = fixture();
    for (const query of ['', ' \n\t ', 'x'.repeat(1001), null as unknown as string])
      await rejectsCode(f.search(query, 5, signal()), 'WEB_SEARCH_INVALID_QUERY');
    for (const limit of [0, 11, 2.5, NaN, Infinity])
      await rejectsCode(f.search('public', limit, signal()), 'WEB_SEARCH_INVALID_LIMIT');
    expect(f.calls).toHaveLength(0);
  });

  test('parses CRLF SSE with notifications and multiline data', async () => {
    const payload = JSON.stringify(reply(entry()), null, 2)
      .split('\n')
      .map((line) => `data: ${line}`)
      .join('\r\n');
    const text = `: keepalive\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n${payload}\r\n\r\n`;
    const output = await fixture(undefined, {
      contentType: 'text/event-stream; charset=utf-8',
      text,
    }).search('public', 5, signal());
    expect(output.results).toHaveLength(1);
  });

  test('reads all text blocks and normalizes and deduplicates destinations', async () => {
    const f = fixture({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          { type: 'image' },
          {
            type: 'text',
            text:
              entry('https://fictional.example:443/page#one') +
              '\n\n---\n\n' +
              entry('https://fictional.example/page#two', 'Duplicate'),
          },
          {
            type: 'text',
            text: 'Title: N/A\nURL: https://second.example/\nHighlights:\n  Another\n result',
          },
        ],
      },
    });
    const output = await f.search('public', 5, signal());
    expect(output.results).toEqual([
      {
        title: 'Fictional title',
        url: 'https://fictional.example/page',
        snippet: 'Fictional snippet',
      },
      { title: 'second.example', url: 'https://second.example/', snippet: 'Another result' },
    ]);
  });

  test('filters unsafe URLs and honors private-address policy', async () => {
    const f = fixture(
      reply(
        [
          entry(),
          entry('http://127.0.0.1/local'),
          entry('http://198.18.0.23/fake'),
          entry('javascript:alert(1)'),
          entry('https://user:SECRET@fictional.example/'),
        ].join('\n\n---\n\n'),
      ),
    );
    const publicOnly = await f.search('public', 5, signal());
    expect(publicOnly.results).toHaveLength(1);
    expect(publicOnly.truncated).toBe(true);
    const privateAllowed = await f.search('public', 5, signal(), { allowPrivateAddresses: true });
    expect(privateAllowed.results).toHaveLength(3);
    expect(JSON.stringify(privateAllowed)).not.toContain('SECRET');
  });

  test('bounds counts, Unicode previews and the full output envelope', async () => {
    const text = Array.from({ length: 12 }, (_, i) =>
      entry(`https://fictional.example/${i}`, '😀'.repeat(500), '雪'.repeat(1000)),
    ).join('\n\n---\n\n');
    const output = await fixture(reply(text)).search('雪'.repeat(1000), 10, signal());
    expect(output.results.length).toBeGreaterThan(0);
    expect(output.results.length).toBeLessThanOrEqual(10);
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16 * 1024);
    for (const item of output.results) {
      expect(Array.from(item.title)).toHaveLength(200);
      expect(Array.from(item.snippet)).toHaveLength(600);
    }
    expect((await fixture(reply(text)).search('public', 1, signal())).results).toHaveLength(1);
  });

  test('distinguishes genuine empty results from malformed/provider error responses', async () => {
    expect(
      (await fixture(reply('No search results found.')).search('public', 5, signal())).status,
    ).toBe('no_results');
    for (const text of ['', 'SECRET upstream error'])
      await rejectsCode(fixture(reply(text)).search('public', 5, signal()), 'WEB_SEARCH_LAYOUT');
    for (const value of [
      {},
      { ...reply(entry()), id: 2 },
      { ...reply(entry()), result: { content: [] } },
    ])
      await rejectsCode(fixture(value).search('public', 5, signal()), 'WEB_SEARCH_PARSE');
    for (const value of [
      { jsonrpc: '2.0', id: 1, error: { message: 'SECRET' } },
      {
        ...reply('SECRET'),
        result: { isError: true, content: [{ type: 'text', text: 'SECRET' }] },
      },
    ])
      await rejectsCode(fixture(value).search('public', 5, signal()), 'WEB_SEARCH_PROVIDER');
    await rejectsCode(
      fixture(undefined, { text: 'SECRET' }).search('public', 5, signal()),
      'WEB_SEARCH_PARSE',
    );
    await rejectsCode(
      fixture(undefined, { contentType: 'text/html' }).search('public', 5, signal()),
      'WEB_SEARCH_PARSE',
    );
    await rejectsCode(
      fixture(undefined, { contentType: 'text/event-stream', text: 'data: {}\n\n' }).search(
        'public',
        5,
        signal(),
      ),
      'WEB_SEARCH_PARSE',
    );
  });

  test('recognizes the real HTTP-200 free MCP quota message in JSON and SSE', async () => {
    const text =
      "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.\n\nFix: Create API key. SECRET";
    for (const isError of [undefined, false, true]) {
      const value = { ...reply(text), result: { ...reply(text).result, isError } };
      const responses = [
        fixture(value),
        fixture(undefined, {
          contentType: 'text/event-stream',
          text: `event: message\ndata: ${JSON.stringify(value)}\n\n`,
        }),
      ];
      for (const f of responses) {
        await expect(f.search('public', 5, signal())).rejects.toMatchObject({
          code: 'WEB_SEARCH_RATE_LIMIT',
          message:
            'Exa free MCP quota or rate limit was exceeded. Wait for the quota to reset or configure EXA_API_KEY on the service host. Do not retry with different search terms.',
        });
        expect(f.calls).toHaveLength(1);
      }
    }
    const result = await fixture(
      reply(entry('https://fictional.example/', 'Quota explanation', text)),
    ).search('public', 5, signal());
    expect(result.status).toBe('results');
    expect(result.results).toHaveLength(1);
  });

  test('reports HTTP auth, quotas, incomplete bodies and response limits accurately', async () => {
    for (const [status, code] of [
      [401, 'WEB_SEARCH_AUTH'],
      [403, 'WEB_SEARCH_AUTH'],
      [429, 'WEB_SEARCH_RATE_LIMIT'],
      [500, 'WEB_SEARCH_HTTP'],
    ] as const)
      await rejectsCode(fixture(undefined, { status }).search('public', 5, signal()), code);
    await rejectsCode(
      fixture(undefined, { truncated: true }).search('public', 5, signal()),
      'WEB_SEARCH_RESPONSE_LIMIT',
    );
    await rejectsCode(
      fixture(undefined, { text: 'x'.repeat(256 * 1024) }).search('public', 5, signal()),
      'WEB_SEARCH_RESPONSE_LIMIT',
    );
  });

  test('keeps transport categories without leaking diagnostics', async () => {
    for (const [transport, code] of [
      ['WEB_FORBIDDEN_ADDRESS', 'WEB_FORBIDDEN_ADDRESS'],
      ['WEB_DNS_FAILED', 'WEB_SEARCH_DNS'],
      ['WEB_NETWORK_FAILED', 'WEB_SEARCH_NETWORK'],
      ['WEB_TIMEOUT', 'WEB_SEARCH_TIMEOUT'],
      ['unexpected', 'WEB_SEARCH_FETCH'],
    ] as const) {
      const search = createWebSearcher({
        request: async () => {
          throw new AppError(transport, 'SECRET');
        },
      });
      try {
        await search('public', 5, signal());
        throw new Error('Expected failure');
      } catch (e) {
        expect(e).toMatchObject({ code });
        expect((e as Error).message).not.toContain('SECRET');
      }
    }
  });

  test('rejects pre-aborted and mid-request cancellation without parsing a partial result', async () => {
    const caller = new AbortController();
    caller.abort();
    const f = fixture();
    await rejectsCode(f.search('public', 5, caller.signal), 'WEB_SEARCH_ABORTED');
    expect(f.calls).toHaveLength(0);
    const running = new AbortController();
    const search = createWebSearcher({
      request: async () => {
        running.abort();
        throw new Error('SECRET');
      },
    });
    await rejectsCode(search('public', 5, running.signal), 'WEB_SEARCH_ABORTED');
  });

  test('guarded transport sends POST JSON, accepts SSE and never forwards POST redirects', async () => {
    let received = '';
    let method = '';
    let accept = '';
    let redirect = false;
    let requests = 0;
    const body = JSON.stringify({ query: 'public' });
    const fetcher = createWebFetcher(
      {
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
        request: (_url, options, callback) => {
          requests++;
          method = String(options.method);
          accept = (options.headers as Record<string, string>).Accept;
          const req = new EventEmitter() as EventEmitter & {
            end: (text: string) => void;
            destroy: () => void;
          };
          req.destroy = () => {
            req.emit('close');
          };
          req.end = (text) => {
            received = text;
            queueMicrotask(() => {
              const res = Object.assign(new PassThrough(), {
                statusCode: redirect ? 302 : 200,
                headers: redirect
                  ? { location: 'https://other.example/' }
                  : { 'content-type': 'text/event-stream' },
                complete: true,
              });
              callback(res as unknown as IncomingMessage);
              if (!res.destroyed) res.end(`data: ${JSON.stringify(reply(entry()))}\n\n`);
            });
          };
          return req as unknown as ClientRequest;
        },
      },
      {
        maxBytes: 256 * 1024,
        maxChars: 256 * 1024,
        post: {
          body,
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
          },
        },
      },
    );
    await rejectsCode(fetcher('https://mcp.exa.ai/mcp', signal()), 'WEB_FORBIDDEN_ADDRESS');
    const output = await fetcher('https://mcp.exa.ai/mcp', signal(), {
      allowPrivateAddresses: true,
    });
    expect(output.status).toBe(200);
    expect(output.text).toContain('data:');
    expect(received).toBe(body);
    expect(method).toBe('POST');
    expect(accept).toBe('application/json, text/event-stream');
    redirect = true;
    await rejectsCode(
      fetcher('https://mcp.exa.ai/mcp', signal(), { allowPrivateAddresses: true }),
      'WEB_INVALID_REDIRECT',
    );
    expect(requests).toBe(2);
  });
});
