import {
  OPENAI_COMPAT_MAX_TOKENS_CEILING,
  OPENAI_COMPAT_SAFE_DEFAULT_MAX_TOKENS,
} from '../core/max-tokens.js';
import type { Provider } from './types.js';
import {
  createOpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './openai-compatible.js';
import {
  readVercelCliAuthToken,
  VERCEL_GATEWAY_MISSING_KEY_HINT,
} from '../core/vercel-auth.js';

/** Default model via AI Gateway (`provider/model` slug). */
export const VERCEL_AI_GATEWAY_DEFAULT_MODEL = 'openai/gpt-5.4';

/** AI Gateway OpenAI-compatible base URL. */
export const VERCEL_AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

export interface VercelAiGatewayProviderOptions {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  defaultModel?: string;
  baseUrl?: string;
}

/**
 * Vercel AI Gateway — unified OpenAI-compatible endpoint for the live model
 * catalog (`creator/model` slugs). Auth uses AI Gateway keys, OIDC, or the
 * local Vercel CLI token. See https://vercel.com/docs/ai-gateway.
 */
export function createVercelAiGatewayProvider(
  opts: VercelAiGatewayProviderOptions = {},
): Provider {
  const config: OpenAICompatibleConfig = {
    id: 'vercel-ai-gateway',
    name: 'Vercel AI Gateway',
    baseUrl: opts.baseUrl ?? VERCEL_AI_GATEWAY_BASE_URL,
    defaultModel: opts.defaultModel ?? VERCEL_AI_GATEWAY_DEFAULT_MODEL,
    apiKeyEnvVar: 'AI_GATEWAY_API_KEY',
    apiKeyEnvFallbacks: ['VERCEL_OIDC_TOKEN', 'VERCEL_TOKEN'],
    modelsRequireKey: false,
    modelTypes: ['language'],
    capabilities: {
      streaming: true,
      toolCalling: true,
      vision: true,
      embeddings: false,
    },
    headers: opts.headers,
    fetchImpl: opts.fetchImpl,
    extraApiKeySources: [() => readVercelCliAuthToken()],
    missingApiKeyHint: VERCEL_GATEWAY_MISSING_KEY_HINT,
    defaultMaxTokens: OPENAI_COMPAT_SAFE_DEFAULT_MAX_TOKENS,
    maxTokensCeiling: OPENAI_COMPAT_MAX_TOKENS_CEILING,
  };
  return createOpenAICompatibleProvider(config);
}

/** Default Vercel AI Gateway provider instance (used by the default registry). */
export const vercelAiGateway: Provider = createVercelAiGatewayProvider();
