import type { Provider } from './types.js';
import { createOpenAICompatibleProvider } from './openai-compatible.js';

/**
 * Default OpenAI-compatible providers (including the OpenCode gateway above,
 * these all share one adapter — that's the point of the hitch).
 */
export const openai: Provider = createOpenAICompatibleProvider({
  id: 'openai',
  name: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o-mini',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: true,
    maxContextTokens: 128_000,
  },
});

export const groq: Provider = createOpenAICompatibleProvider({
  id: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  defaultModel: 'llama-3.3-70b-versatile',
  apiKeyEnvVar: 'GROQ_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: false,
    embeddings: false,
    maxContextTokens: 128_000,
  },
});

export const openrouter: Provider = createOpenAICompatibleProvider({
  id: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'meta-llama/llama-3.1-8b-instruct:free',
  apiKeyEnvVar: 'OPENROUTER_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
  },
});

/** Vercel AI Gateway — one OpenAI-compatible endpoint for its live model catalog. */
export const vercelAiGateway: Provider = createOpenAICompatibleProvider({
  id: 'vercel-ai-gateway',
  name: 'Vercel AI Gateway',
  baseUrl: 'https://ai-gateway.vercel.sh/v1',
  defaultModel: 'openai/gpt-5.4',
  apiKeyEnvVar: 'AI_GATEWAY_API_KEY',
  apiKeyEnvFallbacks: ['VERCEL_OIDC_TOKEN'],
  modelsRequireKey: false,
  modelTypes: ['language'],
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
  },
});

export const together: Provider = createOpenAICompatibleProvider({
  id: 'together',
  name: 'Together AI',
  baseUrl: 'https://api.together.xyz/v1',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  apiKeyEnvVar: 'TOGETHER_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
  },
});

export const huggingface: Provider = createOpenAICompatibleProvider({
  id: 'huggingface',
  name: 'HuggingFace',
  baseUrl: 'https://router.huggingface.co/v1',
  defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
  apiKeyEnvVar: 'HF_TOKEN',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
    maxContextTokens: 128_000,
  },
});

export const gemini: Provider = createOpenAICompatibleProvider({
  id: 'gemini',
  name: 'Google Gemini',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  defaultModel: 'gemini-3.7-flash',
  apiKeyEnvVar: 'GEMINI_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
    maxContextTokens: 1_000_000,
  },
});

export const deepseek: Provider = createOpenAICompatibleProvider({
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-v4-pro',
  apiKeyEnvVar: 'DEEPSEEK_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: false,
    embeddings: false,
    maxContextTokens: 1_000_000,
  },
});

export const xai: Provider = createOpenAICompatibleProvider({
  id: 'xai',
  name: 'xAI (Grok)',
  baseUrl: 'https://api.x.ai/v1',
  defaultModel: 'grok-4.6',
  apiKeyEnvVar: 'XAI_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
    maxContextTokens: 500_000,
  },
});

export const mistral: Provider = createOpenAICompatibleProvider({
  id: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
  defaultModel: 'mistral-medium-3-5',
  apiKeyEnvVar: 'MISTRAL_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
    maxContextTokens: 256_000,
  },
});

export const moonshot: Provider = createOpenAICompatibleProvider({
  id: 'moonshot',
  name: 'Moonshot (Kimi)',
  baseUrl: 'https://api.moonshot.ai/v1',
  defaultModel: 'kimi-k3',
  apiKeyEnvVar: 'MOONSHOT_API_KEY',
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
    maxContextTokens: 1_000_000,
  },
});

export const zai: Provider = createOpenAICompatibleProvider({
  id: 'zai',
  name: 'Z.ai (GLM)',
  baseUrl: 'https://api.z.ai/api/paas/v4/',
  defaultModel: 'glm-5.2',
  apiKeyEnvVar: 'ZAI_API_KEY',
  capabilities: { streaming: true, toolCalling: true, vision: false, embeddings: false, maxContextTokens: 1_000_000 },
});

/** LM Studio — fully local, no key required. */
export const lmstudio: Provider = createOpenAICompatibleProvider({
  id: 'lmstudio',
  name: 'LM Studio (local)',
  baseUrl: 'http://localhost:1234/v1',
  defaultModel: 'local-model',
  requiresKey: false,
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: false,
    embeddings: true,
  },
});

/** vLLM — fully local, no key required. Serves whatever models are loaded. */
export const vllm: Provider = createOpenAICompatibleProvider({
  id: 'vllm',
  name: 'vLLM (local)',
  baseUrl: 'http://localhost:8000/v1',
  defaultModel: 'local-model',
  requiresKey: false,
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: false,
    embeddings: false,
  },
});

/** llama.cpp (llama-server) — fully local, no key required. */
export const llamacpp: Provider = createOpenAICompatibleProvider({
  id: 'llamacpp',
  name: 'llama.cpp (local)',
  baseUrl: 'http://localhost:8080/v1',
  defaultModel: 'local-model',
  requiresKey: false,
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: false,
    embeddings: false,
  },
});

/** KoboldCpp — fully local, no key required. */
export const koboldcpp: Provider = createOpenAICompatibleProvider({
  id: 'koboldcpp',
  name: 'KoboldCpp (local)',
  baseUrl: 'http://localhost:5001/v1',
  defaultModel: 'local-model',
  requiresKey: false,
  capabilities: {
    streaming: true,
    toolCalling: true,
    vision: false,
    embeddings: false,
  },
});
