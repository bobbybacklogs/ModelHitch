export {
  openai,
  groq,
  huggingface,
  openrouter,
  together,
  gemini,
  deepseek,
  xai,
  mistral,
  moonshot,
  zai,
  lmstudio,
  vllm,
  llamacpp,
  koboldcpp,
} from './defaults.js';
export {
  vercelAiGateway,
  createVercelAiGatewayProvider,
  VERCEL_AI_GATEWAY_BASE_URL,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL,
  type VercelAiGatewayProviderOptions,
} from './vercel-ai-gateway.js';
export { createOpenAICompatibleProvider, OpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js';
export { createAnthropicProvider, AnthropicProvider, type AnthropicProviderOptions, anthropic } from './anthropic.js';
export { createOllamaProvider, OllamaProvider, type OllamaProviderOptions, ollama } from './ollama.js';
export { mockProvider } from './mock.js';
export {
  createCursorCloudProvider,
  validateCursorCloudApiKey,
  CURSOR_CLOUD_API_BASE,
  CURSOR_CLOUD_PROVIDER_ID,
  parseSseBlock,
  type CursorCloudProviderOptions,
  type SseEvent,
} from './cursor-cloud.js';
export { CursorCloudSessionStore } from './cursor-cloud-session.js';
// The fs-backed session store is deliberately absent from this barrel: it is
// reachable from the browser entry, and the store uses node:fs. Import it from
// its own module directly, the same way SqliteUsageStorage stays out of the
// browser graph. The record type is safe here because types are erased.
export type { CloudAgentSessionRecord } from './cloud-agent-session-store.js';
export {
  adoptsSessions,
  drivesOwnRuns,
  type CloudAgentBackend,
  type CloudAgentPromptImage,
  type CloudAgentRepo,
  type CloudAgentRunDriver,
  type CloudAgentRunEvent,
  type CloudAgentRunHandle,
  type CloudAgentSession,
  type CloudAgentSessionAdopter,
  type CloudAgentStartInput,
} from './cloud-agent-backend.js';
export {
  createCursorCloudBackend,
  normalizeCursorRunEvent,
  type CursorCloudBackendOptions,
} from './cursor-cloud-backend.js';
// The local agent backend is deliberately absent from this barrel. It
// value-imports the harness, which would drag node:fs, process spawning, and
// workspace writes into the browser entry's import graph. Reach it through its
// own module instead.
export {
  opencode,
  opencodeGo,
  createOpenCodeProvider,
  createMultiWireProvider,
  detectOpenCodeWire,
  OPENCODE_ZEN_BASE_URL,
  OPENCODE_GO_BASE_URL,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_SNAPSHOT_MODELS,
  type MultiWireProviderOptions,
  type OpenCodeProviderOptions,
  type OpenCodeWire,
} from './opencode.js';
export {
  createCustomLaneProvider,
  customLaneBaseUrl,
  customLaneProviderId,
  customLaneSlug,
  customLaneWire,
  isCustomLaneProviderId,
  CUSTOM_LANE_KEY_ENV_PREFIX,
  CUSTOM_LANE_PROVIDER_PREFIX,
  CUSTOM_LANE_SCHEMAS,
  type CreateCustomLaneProviderOptions,
  type CustomLaneInput,
  type CustomLaneSchema,
} from './custom-lane.js';
export {
  createOpenCodeByokProvider,
  isOpenCodeByokProviderId,
  openCodeByokBaseUrl,
  openCodeByokProviderId,
  openCodeByokSlug,
  openCodeByokWire,
  OPENCODE_BYOK_BASE_URL_PREFIX,
  OPENCODE_BYOK_KEY_ENV,
  OPENCODE_BYOK_KEY_ID,
  OPENCODE_BYOK_PROVIDER_PREFIX,
  type CreateOpenCodeByokProviderOptions,
  type OpenCodeByokConnectionInput,
  type OpenCodeByokSchema,
} from './opencode-byok.js';
export type { Provider, ModelInfo } from './types.js';
export {
  createChatGptPlanProvider,
  chatGptPlanRequestBody,
  type ChatGptPlanProviderOptions,
} from './chatgpt-plan.js';
