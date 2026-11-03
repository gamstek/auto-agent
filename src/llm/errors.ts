import { AppError } from '../shared/types';

const networkCodes = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
const errorNames = new Set([
  'Error',
  'TypeError',
  'AbortError',
  'TimeoutError',
  'AI_APICallError',
  'AI_RetryError',
  'AI_JSONParseError',
  'AI_TypeValidationError',
  'AI_InvalidResponseDataError',
  'AI_NoContentGeneratedError',
]);
/** No raw message, URL, request/response bodies, headers or provider payloads. */
export function modelErrorDiagnostic(error: unknown) {
  const diagnostic: {
    httpStatus?: number;
    errorNames: string[];
    transportCode?: string;
    requestId?: string;
  } = { errorNames: [] };
  const seen = new Set<object>();
  let current: unknown = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object' && !seen.has(current);
    depth++
  ) {
    seen.add(current);
    const value = current as Record<string, unknown>;
    if (typeof value.name === 'string' && errorNames.has(value.name))
      diagnostic.errorNames.push(value.name);
    if (
      diagnostic.httpStatus === undefined &&
      typeof value.statusCode === 'number' &&
      Number.isInteger(value.statusCode) &&
      value.statusCode >= 100 &&
      value.statusCode <= 599
    )
      diagnostic.httpStatus = value.statusCode;
    if (!diagnostic.transportCode && typeof value.code === 'string' && networkCodes.has(value.code))
      diagnostic.transportCode = value.code;
    if (
      !diagnostic.requestId &&
      value.responseHeaders &&
      typeof value.responseHeaders === 'object'
    ) {
      for (const [key, id] of Object.entries(value.responseHeaders)) {
        if (
          ['x-request-id', 'request-id', 'x-ds-request-id'].includes(key.toLowerCase()) &&
          typeof id === 'string' &&
          /^[A-Za-z0-9._:-]{1,128}$/.test(id)
        ) {
          diagnostic.requestId = id;
          break;
        }
      }
    }
    current = value.cause ?? value.lastError;
  }
  return diagnostic;
}
export class ModelRequestError extends AppError {
  constructor(
    code: string,
    message: string,
    readonly diagnostic: ReturnType<typeof modelErrorDiagnostic>,
  ) {
    super(code, message, 502);
  }
}
