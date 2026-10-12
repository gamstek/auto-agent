import { z } from 'zod';
import { AppError } from '../../shared/types';
import {
  createWebFetcher,
  validateWebURL,
  type WebFetchResult,
  type WebNetworkPolicy,
} from './web-fetch';

const ENDPOINT = 'https://mcp.exa.ai/mcp';
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const replySchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.literal(1),
  result: z
    .object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
    })
    .optional(),
  error: z.unknown().optional(),
});

export interface WebSearchEntry {
  title: string;
  url: string;
  snippet: string;
}
export interface WebSearchResult {
  query: string;
  provider: 'exa';
  results: WebSearchEntry[];
  truncated: boolean;
  status: 'results' | 'no_results';
}
export interface WebSearchDependencies {
  request: (
    body: string,
    signal: AbortSignal,
    policy: WebNetworkPolicy,
    endpoint: string,
  ) => Promise<WebFetchResult>;
}
function failure(code: string, message: string): AppError {
  return new AppError(code, message);
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw failure('WEB_SEARCH_ABORTED', 'Web search was cancelled');
}
function providerEndpoint(): string {
  const url = new URL(ENDPOINT);
  const key = process.env.EXA_API_KEY?.trim();
  if (key) url.searchParams.set('exaApiKey', key);
  return url.href;
}
function checkProviderLimit(content: { type: string; text?: string }[]): void {
  for (const item of content) {
    if (
      item.type === 'text' &&
      /^\s*You've hit Exa's free MCP rate limit\b/i.test(item.text ?? '') &&
      !/^URL:/m.test(item.text ?? '')
    )
      throw failure(
        'WEB_SEARCH_RATE_LIMIT',
        'Exa free MCP quota or rate limit was exceeded. Wait for the quota to reset or configure EXA_API_KEY on the service host. Do not retry with different search terms.',
      );
  }
}
function parseReply(text: string, mime: string) {
  const parse = (data: string) => {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw failure('WEB_SEARCH_PARSE', 'Search provider returned invalid JSON');
    }
    const parsed = replySchema.safeParse(value);
    if (!parsed.success)
      throw failure('WEB_SEARCH_PARSE', 'Search provider returned an invalid MCP response');
    if (parsed.data.result) checkProviderLimit(parsed.data.result.content);
    if (parsed.data.error !== undefined || parsed.data.result?.isError)
      throw failure('WEB_SEARCH_PROVIDER', 'Search provider reported an MCP tool error');
    if (!parsed.data.result)
      throw failure('WEB_SEARCH_PARSE', 'Search provider omitted its MCP tool result');
    return parsed.data.result;
  };
  if (mime === 'application/json') return parse(text);
  // SSE data can span multiple lines. Ignore notifications, but require the matching RPC reply.
  for (const event of text.replace(/\r\n/g, '\n').split(/\n\n/)) {
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') continue;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw failure('WEB_SEARCH_PARSE', 'Search provider returned invalid SSE data');
    }
    if (value && typeof value === 'object' && 'id' in value && value.id === 1) return parse(data);
  }
  throw failure('WEB_SEARCH_PARSE', 'Search provider omitted its MCP tool reply');
}
function clean(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
function clip(text: string, limit: number): { text: string; clipped: boolean } {
  const characters = Array.from(clean(text));
  return { text: characters.slice(0, limit).join(''), clipped: characters.length > limit };
}

export function createWebSearcher(overrides: Partial<WebSearchDependencies> = {}) {
  const request =
    overrides.request ??
    ((body, signal, policy, endpoint) =>
      createWebFetcher(
        {},
        {
          maxBytes: MAX_RESPONSE_BYTES,
          maxChars: MAX_RESPONSE_BYTES,
          post: {
            body,
            headers: {
              Accept: 'application/json, text/event-stream',
              'Content-Type': 'application/json',
            },
          },
        },
      )(endpoint, signal, policy));
  return async (
    query: string,
    limit: number,
    signal: AbortSignal,
    policy: WebNetworkPolicy = {},
  ): Promise<WebSearchResult> => {
    checkAbort(signal);
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 1000)
      throw failure('WEB_SEARCH_INVALID_QUERY', 'Search query must contain 1 to 1000 characters');
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw failure('WEB_SEARCH_INVALID_LIMIT', 'Search limit must be an integer from 1 to 10');
    query = query.trim();
    let response: WebFetchResult;
    try {
      response = await request(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: { query, numResults: limit } },
        }),
        signal,
        policy,
        providerEndpoint(),
      );
    } catch (error) {
      checkAbort(signal);
      const codes: Record<string, [string, string]> = {
        WEB_FORBIDDEN_ADDRESS: [
          'WEB_FORBIDDEN_ADDRESS',
          'Search destination resolved to a private/reserved address forbidden by the configured network policy. Check DNS or operator configuration.',
        ],
        WEB_DNS_FAILED: [
          'WEB_SEARCH_DNS',
          'Could not resolve the Exa search provider host. Check DNS configuration.',
        ],
        WEB_NETWORK_FAILED: [
          'WEB_SEARCH_NETWORK',
          'Could not connect to Exa. Check network and TLS connectivity.',
        ],
        WEB_TIMEOUT: ['WEB_SEARCH_TIMEOUT', 'Exa search request timed out.'],
      };
      const mapped = error instanceof AppError ? codes[error.code] : undefined;
      throw mapped
        ? failure(...mapped)
        : failure('WEB_SEARCH_FETCH', 'Unable to fetch Exa search results');
    }
    checkAbort(signal);
    if (response.status === 401 || response.status === 403)
      throw failure(
        'WEB_SEARCH_AUTH',
        'Exa rejected access; check EXA_API_KEY or anonymous-access availability',
      );
    if (response.status === 429)
      throw failure('WEB_SEARCH_RATE_LIMIT', 'Exa search quota or rate limit was exceeded');
    if (response.status < 200 || response.status >= 300)
      throw failure('WEB_SEARCH_HTTP', 'Exa returned an unsuccessful HTTP status');
    if (response.truncated || Buffer.byteLength(response.text, 'utf8') >= MAX_RESPONSE_BYTES)
      throw failure('WEB_SEARCH_RESPONSE_LIMIT', 'Exa response exceeded the search response limit');
    const mime = response.contentType.split(';')[0].trim().toLowerCase();
    if (!['application/json', 'text/event-stream'].includes(mime))
      throw failure('WEB_SEARCH_PARSE', 'Exa returned an unsupported response format');
    const reply = parseReply(response.text, mime);
    const textItems = reply.content.filter(
      (item) => item.type === 'text' && typeof item.text === 'string',
    );
    if (!textItems.length) throw failure('WEB_SEARCH_PARSE', 'Exa returned no text result');
    const output: WebSearchResult = {
      query,
      provider: 'exa',
      results: [],
      truncated: false,
      status: 'results',
    };
    const seen = new Set<string>();
    let foundURL = false;
    let clipped = false;
    for (const item of textItems) {
      for (const block of item.text!.split(/\r?\n\r?\n---\r?\n\r?\n/)) {
        checkAbort(signal);
        const rawURL = block.match(/^URL:[ \t]*(.+)$/m)?.[1]?.trim();
        if (!rawURL) continue;
        foundURL = true;
        let url: string;
        try {
          url = validateWebURL(rawURL, undefined, policy).href;
        } catch {
          clipped = true;
          continue;
        }
        if (url.length > 2048) {
          clipped = true;
          continue;
        }
        if (seen.has(url)) continue;
        seen.add(url);
        if (output.results.length >= limit) {
          clipped = true;
          continue;
        }
        const rawTitle = block.match(/^Title:[ \t]*(.*)$/m)?.[1]?.trim();
        const title = clip(rawTitle && rawTitle !== 'N/A' ? rawTitle : new URL(url).hostname, 200);
        const snippet = clip(
          block.match(/^(?:Highlights|Text):[ \t]*\r?\n?([\s\S]*)$/m)?.[1] ?? '',
          600,
        );
        const entry = { title: title.text, url, snippet: snippet.text };
        // Reserve the longer false/"no_results" envelope to cover final flag/status changes.
        if (
          Buffer.byteLength(
            JSON.stringify({
              ...output,
              results: [...output.results, entry],
              status: 'no_results',
            }),
            'utf8',
          ) > MAX_JSON_BYTES
        ) {
          clipped = true;
          continue;
        }
        output.results.push(entry);
        clipped ||= title.clipped || snippet.clipped;
      }
    }
    if (
      !foundURL &&
      textItems.some(
        (item) =>
          !/^\s*(?:no (?:search )?results(?: found)?[.!]?|no matches(?: found)?[.!]?)\s*$/i.test(
            item.text!,
          ),
      )
    )
      throw failure('WEB_SEARCH_LAYOUT', 'Exa returned an unrecognized search result layout');
    output.truncated = clipped;
    if (!output.results.length) output.status = 'no_results';
    return output;
  };
}

export const searchWeb = createWebSearcher();
