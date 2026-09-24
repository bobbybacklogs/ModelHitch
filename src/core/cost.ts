import type { Usage } from './types.js';

/**
 * Best-effort cost estimation for tracked usage.
 *
 * Pricing is approximate list price (USD per 1M tokens) as of mid-2026 for
 * common model families; local providers are free. Exact prices drift — treat
 * this as an estimate for dashboards, not billing.
 */
export interface ModelPricing {
  /** USD per 1M input tokens. */
  inputPerMillion?: number;
  /** USD per 1M output tokens. */
  outputPerMillion?: number;
}

/** Exact model id → pricing (wins over family fallback). */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  'openai/gpt-5.4': { inputPerMillion: 2.5, outputPerMillion: 15 },
  'gpt-5.6-luna': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'deepseek-v4-flash': { inputPerMillion: 0.27, outputPerMillion: 1.1 },
  'opencode/deepseek-v4-flash': { inputPerMillion: 0.14, outputPerMillion: 0.28 },
  'qwen3.6-plus': { inputPerMillion: 0.4, outputPerMillion: 1.2 },
  'gemini-3.5-flash-lite': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  // OpenCode Zen pay-per-use exact pricing
  'claude-opus-4-6': { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  'claude-sonnet-4-6': { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'gpt-5.5': { inputPerMillion: 5.0, outputPerMillion: 30.0 },
  'gpt-5.4-mini': { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  'gpt-5-nano': { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  'gpt-5.3-codex': { inputPerMillion: 1.75, outputPerMillion: 14.0 },
  'gemini-3-flash': { inputPerMillion: 0.5, outputPerMillion: 3.0 },
  'grok-4.7': { inputPerMillion: 2.0, outputPerMillion: 6.0 },
  'muse-spark-1.3': { inputPerMillion: 1.25, outputPerMillion: 4.25 },
  'kimi-k2.6': { inputPerMillion: 0.95, outputPerMillion: 4.0 },
  'kimi-k2.5': { inputPerMillion: 0.6, outputPerMillion: 3.0 },
  'glm-5.1': { inputPerMillion: 1.4, outputPerMillion: 4.4 },
  'glm-5': { inputPerMillion: 1.0, outputPerMillion: 3.2 },
  'deepseek-v4-pro': { inputPerMillion: 1.74, outputPerMillion: 3.48 },
  'qwen3.7-max': { inputPerMillion: 2.5, outputPerMillion: 7.5 },
  'minimax-m2.7': { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  // OpenCode free tier
  'big-pickle': { inputPerMillion: 0, outputPerMillion: 0 },
  'space-bunny-free': { inputPerMillion: 0, outputPerMillion: 0 },
  'mimo-v2.6-flash-free': { inputPerMillion: 0, outputPerMillion: 0 },
  'mimo-v2.5-free': { inputPerMillion: 0, outputPerMillion: 0 },
  'ling-3.0-flash-fin-free': { inputPerMillion: 0, outputPerMillion: 0 },
  'nemotron-3-ultra-free': { inputPerMillion: 0, outputPerMillion: 0 },
  'nemotron-3.5-lightning-free': { inputPerMillion: 0, outputPerMillion: 0 },
  'muse-spark-1.3-contributor-free': { inputPerMillion: 0, outputPerMillion: 0 },
  'jev-1.13-free': { inputPerMillion: 0, outputPerMillion: 0 },
};

/** Model family prefixes → pricing fallback. */
const FAMILY_PRICING: Array<{ prefix: string; pricing: ModelPricing }> = [
  { prefix: 'openai/', pricing: { inputPerMillion: 2.5, outputPerMillion: 15 } },
  { prefix: 'anthropic/', pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  { prefix: 'google/', pricing: { inputPerMillion: 0.3, outputPerMillion: 1.5 } },
  { prefix: 'gpt-', pricing: { inputPerMillion: 2.5, outputPerMillion: 10 } },
  { prefix: 'grok-', pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2 } },
  { prefix: 'claude-', pricing: { inputPerMillion: 3, outputPerMillion: 15 } },
  { prefix: 'gemini-', pricing: { inputPerMillion: 0.3, outputPerMillion: 1.5 } },
  { prefix: 'qwen', pricing: { inputPerMillion: 0.4, outputPerMillion: 1.2 } },
  { prefix: 'deepseek-', pricing: { inputPerMillion: 0.27, outputPerMillion: 1.1 } },
  { prefix: 'llama-', pricing: { inputPerMillion: 0.2, outputPerMillion: 0.6 } },
  // Local providers — free.
  { prefix: 'local-model', pricing: { inputPerMillion: 0, outputPerMillion: 0 } },
];

/** Providers that are always local/free regardless of model id. */
const LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio', 'vllm', 'llamacpp', 'koboldcpp']);

export interface CostEstimate {
  /** True when a pricing entry was found; false = free or unknown (0 cost). */
  priced: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

/** Resolve pricing for a model id (optionally scoped to a provider id). */
export function pricingFor(model: string, providerId?: string): ModelPricing {
  if (providerId === 'opencode-go' || (providerId && LOCAL_PROVIDER_IDS.has(providerId))) {
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }
  const cleanModel = model.replace(/^(?:opencode|opencode-go)\//, '');
  const exact = MODEL_PRICING[model] ?? MODEL_PRICING[cleanModel];
  if (exact) return exact;
  for (const { prefix, pricing } of FAMILY_PRICING) {
    if (cleanModel.startsWith(prefix) || model.startsWith(prefix)) return pricing;
  }
  return {};
}

/** Estimate USD cost of a usage record. Returns 0s for free/unknown models. */
export function estimateCost(model: string, usage: Usage, providerId?: string): CostEstimate {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const pricing = pricingFor(model, providerId);
  const inputCostUsd =
    pricing.inputPerMillion === undefined ? 0 : (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCostUsd =
    pricing.outputPerMillion === undefined ? 0 : (outputTokens / 1_000_000) * pricing.outputPerMillion;
  return {
    priced: pricing.inputPerMillion !== undefined || pricing.outputPerMillion !== undefined,
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}
