// ModelHitch — plug-and-play BYOK integration layer.
// Browser-safe entry: the full library surface minus the Node-only bridge
// server and SQLite usage persistence. Bundlers resolve this entry via the
// `browser` export condition (or `modelhitch/browser` explicitly), so web
// apps never pull in `node:` modules.

export { ModelHitch, type ModelHitchOptions, type ChatInput } from './client.js';
export { ASCII_LOGO, printAsciiLogo } from './ascii.js';
export { runToolLoop, type ToolExecutor, type ToolLoopOptions, type ToolLoopEvent } from './agent.js';
export { defaultProviders } from './registry.js';
export { MemoryKeyStore } from './storage/memory.js';
export { LocalStorageKeyStore } from './storage/local-storage.js';

// auto-mode: rate-limit failover + usage tracking
export {
  DEFAULT_FAILOVER_LANES,
  DEFAULT_RETRYABLE_CODES,
  errorInfo,
  isRetryableError,
  isCredentialError,
  resolveLanes,
  retryableCodesFor,
  maxAttemptsFor,
  withFailover,
  withFailoverStream,
  ExhaustedError,
  isExhaustedError,
  type AutoModeOptions,
  type ExhaustionInfo,
  type FailoverContext,
  type FailoverEvent,
  type FailoverTarget,
  type FailoverErrorInfo,
  type LaneAttempt,
  type LaneCooldown,
} from './core/failover.js';

// circuit breaker (Milestone 3) — threshold health per lane
export { CircuitBreaker, type CircuitBreakerOptions, type LaneHealth, type LaneHealthState } from './core/circuit-breaker.js';

// policy-driven routing (Milestone 1)
export {
  createRegistrySource,
  resolvePolicyLanes,
  validatePolicy,
  type BackoffOptions,
  type Policy,
  type PolicyValidation,
  type ProviderSource,
  type TrustListEntry,
} from './core/policy.js';

// lane cooling / Retry-After handling
export { MemoryLaneCooldown, type MemoryLaneCooldownOptions } from './core/cooldown.js';
export { parseRetryAfter } from './core/headers.js';

// capability-aware routing — skip lanes that can't meet a request's needs
export {
  inferRequirements,
  satisfiesRequirements,
  filterEligibleLanes,
  CapabilityUnavailableError,
  isCapabilityUnavailableError,
  type CapabilityRequirements,
  type SkippedCapabilityLane,
} from './core/capabilities.js';

// models.dev catalog integration (Milestone 2) — browser-safe (fetch + mdev-sdk)
export { createCatalogSource, isCallableProvider } from './catalog/source.js';
export type {
  CatalogModelMeta,
  CatalogProviderMeta,
  CatalogSource,
  CatalogSourceOptions,
  CatalogUsability,
} from './catalog/source.js';

// settings surface (Milestone 5) — browser-safe subset (no file I/O)
export {
  buildCatalogOptions,
  buildCooldownFromConfig,
  isMaskedSecret,
  maskSecret,
  policyFromConfig,
  serializeConfig,
  validateConfig,
  CONFIG_VERSION,
  type CatalogConfig,
  type CooldownConfig,
  type ConfigValidation,
  type CustomLaneConfig,
  type CustomLanesConfig,
  type MaskedConfig,
  type ModelHitchConfig,
} from './config.js';

// custom BYOK lanes — endpoints ModelHitch does not ship, used as ordinary lanes
export {
  applyCustomLanesPlan,
  customLaneApiKeys,
  customLaneProviders,
  customLanesConfig,
  customLanesPlacement,
  describeCustomLanesPlan,
  isCustomLanesEnabled,
  resolveCustomLanes,
  type CustomLaneProviderOptions,
  type CustomLanesPlan,
  type CustomLanesPlanInput,
  type ResolvedCustomLane,
} from './custom-lanes.js';
export {
  createCustomLaneProvider,
  customLaneBaseUrl,
  customLaneKeyEnvVar,
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
} from './providers/custom-lane.js';

// Sign in with ChatGPT — the ChatGPT plan lane's routing plan and adapter.
// The OAuth flow itself is Node-only (`chatgpt-plan-auth.ts`: loopback
// listener, JWKS validation, credential file) and is deliberately absent here.
// A browser build drives the lane by supplying its own `ChatGptPlanTokenSource`
// — for example one that asks an app server for a token, so the refresh token
// never reaches browser storage.
export {
  applyChatGptPlanPlan,
  chatGptPlanConfig,
  chatGptPlanMode,
  chatGptPlanModelSlug,
  chatGptPlanPlacement,
  describeChatGptPlan,
  hasChatGptPlanScope,
  isChatGptPlanEnabled,
  isTokenExpired,
  parseScopeValue,
  redactToken,
  resolveChatGptPlan,
  chatGptPlanAccountKey,
  chatGptPlanAccountLabel,
  CHATGPT_PLAN_API_BASE_URL,
  CHATGPT_PLAN_DYNAMIC_CLIENT_ID,
  CHATGPT_PLAN_PROVIDER_ID,
  CHATGPT_PLAN_PROVIDER_NAME,
  CHATGPT_PLAN_RESOURCE,
  CHATGPT_PLAN_USAGE_SCOPE,
  CHATGPT_PLAN_USAGE_SETTINGS_URL,
  type ChatGptPlanAccount,
  type ChatGptPlanAccountStatus,
  type ChatGptPlanPlan,
  type ChatGptPlanPlanInput,
  type ChatGptPlanSignInAttempt,
  type ChatGptPlanSignInStatus,
  type ChatGptPlanStatus,
  type ChatGptPlanToken,
  type ChatGptPlanTokenSource,
  type ResolvedChatGptPlanLane,
  type ResolveChatGptPlanOptions,
} from './chatgpt-plan.js';
export {
  chatGptPlanProviders,
  isChatGptPlanProviderId,
  listChatGptPlanAccountModels,
  type ChatGptPlanLaneOptions,
} from './chatgpt-plan-lane.js';
export {
  createChatGptPlanProvider,
  chatGptPlanRequestBody,
  type ChatGptPlanProviderOptions,
} from './providers/chatgpt-plan.js';

export { UsageTracker, usageDashboardHtml } from './core/usage.js';
// `UsageStorage` is an interface only — safe for browsers. `SqliteUsageStorage`
// (the Node `node:sqlite` implementation) stays Node-only and is not exported
// here.
export type { UsageStorage } from './core/usage-storage.js';
export type {
  UsageEvent,
  UsageSnapshot,
  UsageSlice,
  UsageTotals,
} from './core/usage.js';

export {
  // Provider framework
  createOpenAICompatibleProvider,
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
  createAnthropicProvider,
  AnthropicProvider,
  createOllamaProvider,
  OllamaProvider,
  // Multi-wire engine (chat completions / responses / messages / generateContent)
  createMultiWireProvider,
  type MultiWireProviderOptions,
  type Provider,
  type ModelInfo,
  // Vercel AI Gateway (default runtime)
  vercelAiGateway,
  createVercelAiGatewayProvider,
  VERCEL_AI_GATEWAY_BASE_URL,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL,
  type VercelAiGatewayProviderOptions,
  // Default providers
  openai,
  anthropic,
  groq,
  openrouter,
  together,
  huggingface,
  gemini,
  deepseek,
  xai,
  mistral,
  moonshot,
  zai,
  lmstudio,
  ollama,
  vllm,
  llamacpp,
  koboldcpp,
  mockProvider,
} from './providers/index.js';

export {
  ModelHitchError,
  isModelHitchError,
  type ModelHitchErrorCode,
} from './core/errors.js';

export {
  aggregateStream,
  parseSSE,
  parseLines,
  bodyToAsyncIterable,
} from './core/stream.js';

export type {
  ModelMessage,
  ContentPart,
  ToolDefinition,
  ToolCall,
  ChatParams,
  ChatResult,
  StreamChunk,
  Usage,
  Capabilities,
  ProviderCredentials,
} from './core/types.js';

export type { KeyStore } from './core/keystore.js';
