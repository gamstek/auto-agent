import { APICallError, type LanguageModelMiddleware } from 'ai';

function explainModelError(error: unknown, interactive: boolean): unknown {
  if (!APICallError.isInstance(error)) return error;
  if ([401, 403].includes(error.statusCode ?? 0)) {
    error.message = `模型服务认证或访问权限校验失败（HTTP ${error.statusCode}）。请检查模型配置中的服务地址、API Key 和模型访问权限。`;
    return error;
  }
  // A rejected model call fails the turn. Corax parks ordinary errors for new
  // input; propagating the SDK error (even as cause) can terminate the session.
  if (interactive && !error.isRetryable) {
    const status = error.statusCode === undefined ? '' : `（HTTP ${error.statusCode}）`;
    return new Error(`模型调用失败${status}：${error.message}`);
  }
  return error;
}

/** Explain authentication or authorization failures reported by the provider. */
function errorMiddleware(interactive: boolean): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    async wrapGenerate({ doGenerate }) {
      try {
        return await doGenerate();
      } catch (error) {
        throw explainModelError(error, interactive);
      }
    },
    async wrapStream({ doStream }) {
      try {
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                controller.enqueue(
                  part.type === 'error'
                    ? { ...part, error: explainModelError(part.error, interactive) }
                    : part,
                );
              },
            }),
          ),
        };
      } catch (error) {
        throw explainModelError(error, interactive);
      }
    },
  };
}

export const modelErrorMiddleware = errorMiddleware(false);
export const chatErrorMiddleware = errorMiddleware(true);
