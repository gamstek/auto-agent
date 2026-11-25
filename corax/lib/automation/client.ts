import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { AppConfig } from '../config/schema';
import {
  createBatchInput,
  creationResponse,
  experimentQuery,
  progressResponse,
  resultsResponse,
  templateQuery,
  templatesResponse,
} from './contracts';
import { pendingCreates } from './pending';

type Options = { signal?: AbortSignal };
type Identity = { sessionId: string; callId: string };
const responseLimit = 8 * 1024 * 1024;

class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly rejected = false,
  ) {
    super(message);
  }
}

function requestId(scope: Identity, index: number) {
  // Corax re-evaluation of the same call must not create new experiment identities.
  const hex = createHash('sha256')
    .update(JSON.stringify([scope.sessionId, scope.callId, index]))
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function responseJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new RequestError('INVALID_RESPONSE', '仪器未返回响应内容。');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit)
        throw new RequestError('RESPONSE_TOO_LARGE', '仪器响应超过 8 MiB，请缩小查询范围。');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof SyntaxError)
      throw new RequestError('INVALID_RESPONSE', '仪器返回的内容不是有效 JSON。');
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function correlate<T extends { experimentId: string }>(ids: string[], items: T[]) {
  const byId = new Map(items.map((item) => [item.experimentId, item]));
  if (items.length !== ids.length || byId.size !== ids.length || ids.some((id) => !byId.has(id)))
    throw new RequestError('INVALID_RESPONSE', '仪器回执中的实验编号与本次请求不符。');
  return ids.map((id) => byId.get(id)!);
}

export function automationClient(
  { automation: config, dataDir }: Pick<AppConfig, 'automation' | 'dataDir'>,
  options: Options = {},
) {
  const pending = config.enabled ? pendingCreates(dataDir, config.serviceURL) : undefined;

  function resolvePending(experimentIds: string[]) {
    try {
      pending?.resolve(experimentIds);
      return {};
    } catch {
      return { reconciliationNote: '已取得仪器回执，但本机待核对记录未能更新；可重新查询进度。' };
    }
  }

  async function request<T extends z.ZodType>(
    path:
      '/experiment-templates' | '/experiments' | '/experiments/progress' | '/experiments/results',
    schema: T,
    params: [string, string[]] | undefined,
    body?: unknown,
  ): Promise<z.output<T>> {
    if (!config.enabled) throw new RequestError('DISABLED', '尚未启用自动化仪器。', true);
    const url = new URL(config.serviceURL);
    url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
    if (params) for (const value of params[1]) url.searchParams.append(params[0], value);
    const headers = new Headers({ accept: 'application/json' });
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (options.signal?.aborted) throw new RequestError('CANCELLED', '请求在发送前取消。', true);
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal,
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {});
        throw new RequestError(
          `HTTP_${response.status}`,
          `仪器返回 HTTP ${response.status}。`,
          [400, 401, 403].includes(response.status),
        );
      }
      const parsed = schema.safeParse(await responseJson(response));
      if (!parsed.success)
        throw new RequestError('INVALID_RESPONSE', '仪器回执不符合批量接口契约。');
      return parsed.data;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (timeout.aborted) throw new RequestError('TIMEOUT', '仪器请求超时。');
      if (options.signal?.aborted) throw new RequestError('CANCELLED', '仪器请求已取消。');
      throw new RequestError('CONNECTION_FAILED', '无法取得仪器回执。');
    }
  }

  return {
    async templates(input: z.input<typeof templateQuery>) {
      const { templateIds } = templateQuery.parse(input);
      const result = await request(
        '/experiment-templates',
        templatesResponse,
        templateIds && ['templateId', templateIds],
      );
      if (templateIds && result.items.some(({ templateId }) => !templateIds.includes(templateId)))
        throw new RequestError('INVALID_RESPONSE', '仪器返回了未请求的模板编号。');
      return result;
    },
    async create(input: z.input<typeof createBatchInput>, identity: Identity) {
      const items = createBatchInput
        .parse(input)
        .items.map((item, index) => ({ ...item, experimentId: requestId(identity, index) }));
      const rejected = (code: string, message: string) => ({
        items: items.map(({ experimentId, tubeCode }) => ({
          experimentId,
          tubeCode,
          status: 'rejected',
          code,
          message,
        })),
      });
      if (!pending) return rejected('DISABLED', '尚未启用自动化仪器。');
      if (options.signal?.aborted) return rejected('CANCELLED', '请求在发送前取消。');

      let blocked: Map<string, string>;
      try {
        // Reserve durably before any POST, including across sessions and process restarts.
        blocked = pending.reserve(items);
      } catch {
        return rejected('PENDING_STORE_UNAVAILABLE', '无法保存本机待核对记录，本次未提交。');
      }
      const send = items.filter(({ tubeCode }) => !blocked.has(tubeCode));
      const sendIds = send.map(({ experimentId }) => experimentId);
      function merge<T>(receipts: T[]) {
        let next = 0;
        return items.map(({ tubeCode }) => {
          const experimentId = blocked.get(tubeCode);
          return experimentId === undefined
            ? receipts[next++]!
            : {
                experimentId,
                tubeCode,
                status: 'blocked',
                code: 'AWAITING_RECONCILIATION',
                message: '此样品管上一笔创建仍待核对，本次未提交。请按原实验编号查进度。',
              };
        });
      }
      if (!send.length) return { items: merge([]) };

      try {
        const result = await request('/experiments', creationResponse, undefined, { items: send });
        const receipts = correlate(sendIds, result.items);
        if (
          receipts.some(
            (item, index) => item.status === 'accepted' && item.tubeCode !== send[index]!.tubeCode,
          )
        )
          throw new RequestError('INVALID_RESPONSE', '仪器回执中的样品管码与请求不符。');
        return {
          items: merge(
            receipts.map((receipt, index) => ({
              ...receipt,
              tubeCode: send[index]!.tubeCode,
            })),
          ),
          ...resolvePending(sendIds),
        };
      } catch (error) {
        if (!(error instanceof RequestError)) throw error;
        return {
          items: merge(
            send.map(({ experimentId, tubeCode }) => ({
              experimentId,
              tubeCode,
              status: error.rejected ? 'rejected' : 'unknown',
              code: error.code,
              message: error.rejected
                ? error.message
                : `${error.message}受理状态未知，请按原编号查进度，不要重发创建。`,
            })),
          ),
          ...(error.rejected && resolvePending(sendIds)),
        };
      }
    },
    async progress(input: z.input<typeof experimentQuery>) {
      const { experimentIds } = experimentQuery.parse(input);
      const response = await request('/experiments/progress', progressResponse, [
        'experimentId',
        experimentIds,
      ]);
      const items = correlate(experimentIds, response.items);
      // A missing or otherwise inaccessible experiment is not proof of non-admission.
      const confirmed = items.filter(({ status }) => status !== 'error');
      return { items, ...resolvePending(confirmed.map(({ experimentId }) => experimentId)) };
    },
    async results(input: z.input<typeof experimentQuery>) {
      const { experimentIds } = experimentQuery.parse(input);
      const response = await request('/experiments/results', resultsResponse, [
        'experimentId',
        experimentIds,
      ]);
      return { items: correlate(experimentIds, response.items) };
    },
  };
}
