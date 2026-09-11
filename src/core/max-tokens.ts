/**
 * OpenAI-compatible gateways (notably Vercel AI Gateway) may inject an
 * oversize catalog default when `max_tokens` is omitted from the wire body.
 * vLLM-style backends then reject requests where that default exceeds
 * `max_model_len` (e.g. 65536 > 40960).
 */

/** Catalog default some gateways apply when `max_tokens` is absent from the request. */
export const OPENAI_COMPAT_GATEWAY_CATALOG_DEFAULT_MAX_TOKENS = 65_536;

/** Conservative output cap when the caller omits `maxTokens` on gateway routes. */
export const OPENAI_COMPAT_SAFE_DEFAULT_MAX_TOKENS = 8_192;

/**
 * Upper bound for explicit `maxTokens` on gateway routes. Keeps requests below
 * common vLLM `max_model_len` ceilings without hardcoding a single model id.
 */
export const OPENAI_COMPAT_MAX_TOKENS_CEILING = 32_768;

export interface ResolveOpenAICompatMaxTokensOptions {
  /** Caller-supplied limit (normalized `ChatParams.maxTokens`). */
  maxTokens?: number;
  /** When set, used when `maxTokens` is omitted instead of leaving the field off the wire. */
  defaultMaxTokens?: number;
  /** When set, clamps explicit values above this ceiling before sending. */
  maxTokensCeiling?: number;
}

/**
 * Resolve the `max_tokens` value to send on OpenAI-compatible wire requests.
 * Returns `undefined` when neither a caller value nor a configured default applies
 * (preserves legacy omit behavior for providers that do not need gateway guarding).
 */
export function resolveOpenAICompatMaxTokens(options: ResolveOpenAICompatMaxTokensOptions): number | undefined {
  const { maxTokens, defaultMaxTokens, maxTokensCeiling } = options;
  if (maxTokens !== undefined) {
    if (maxTokensCeiling !== undefined && maxTokens > maxTokensCeiling) {
      return maxTokensCeiling;
    }
    return maxTokens;
  }
  return defaultMaxTokens;
}
