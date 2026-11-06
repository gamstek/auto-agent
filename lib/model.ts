import { APICallError, type LanguageModelMiddleware } from 'ai';

function explainModelError(error: unknown): unknown {
  if (!APICallError.isInstance(error) || ![401, 403].includes(error.statusCode ?? 0)) return error;
  // Preserve the SDK error identity, status and retryability for Corax's own policy.
  error.message = `模型服务认证或访问权限校验失败（HTTP ${error.statusCode}）。请检查模型配置中的服务地址、API Key 和模型访问权限。`;
  return error;
}

/** Describe actual provider failures; never infer a key requirement from a model or URL. */
export const modelErrorMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  async wrapGenerate({ doGenerate }) {
    try {
      return await doGenerate();
    } catch (error) {
      throw explainModelError(error);
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
                part.type === 'error' ? { ...part, error: explainModelError(part.error) } : part,
              );
            },
          }),
        ),
      };
    } catch (error) {
      throw explainModelError(error);
    }
  },
};
