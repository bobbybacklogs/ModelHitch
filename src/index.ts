// ModelHitch — plug-and-play BYOK integration layer.
// Hitch any model to your app: one interface, user-supplied providers & keys.

export { ModelHitch, type ModelHitchOptions, type ChatInput } from './client.js';
export { ASCII_LOGO, printAsciiLogo } from './ascii.js';
export { runToolLoop, type ToolExecutor, type ToolLoopOptions, type ToolLoopEvent } from './agent.js';
export { defaultProviders } from './registry.js';
export { MemoryKeyStore } from './storage/memory.js';
export { LocalStorageKeyStore } from './storage/local-storage.js';

// OpenAI-compatible bridge server (agentic IDEs: Android Studio, JetBrains, ...)
export { OpenAICompatibleServer, createModelHitchServer } from './server/server.js';
export type { ModelHitchServerOptions } from './server/server.js';

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
export { parseRetryAfter } from './core/headers.js';

// models.dev catalog integration (Milestone 2) — consumes mdev-sdk
export { createCatalogSource, isCallableProvider } from './catalog/source.js';
export type {
  CatalogModelMeta,
  CatalogProviderMeta,
  CatalogSource,
  CatalogSourceOptions,
  CatalogUsability,
} from './catalog/source.js';

// settings surface (Milestone 5) — serializable config + shared helpers
export {
  buildCatalogOptions,
  buildCooldownFromConfig,
  isMaskedSecret,
  maskSecret,
  policyFromConfig,
  serializeConfig,
  validateConfig,
  validateConfigWithSource,
  CONFIG_VERSION,
  type CatalogConfig,
  type CooldownConfig,
  type ConfigValidation,
  type ImageGenerationConfig,
  type MaskedConfig,
  type ModelHitchConfig,
} from './config.js';
export { defaultConfigTemplate, initConfigFile, readConfigFile, writeConfigFile } from './config-file.js';

export { UsageTracker, usageDashboardHtml } from './core/usage.js';
export { SqliteUsageStorage, type UsageStorage } from './core/usage-storage.js';
export type {
  UsageEvent,
  UsageSnapshot,
  UsageTotals,
  UsageWindow,
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
  resolveVercelGatewayCredential,
  readVercelCliAuthToken,
  vercelCliAuthPaths,
  VERCEL_GATEWAY_MISSING_KEY_HINT,
  type ResolvedVercelCredential,
  type VercelCredentialSource,
} from './core/vercel-auth.js';

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

export {
  deriveSessionId,
  extractSessionId,
  SESSION_HEADER_CANDIDATES,
} from './core/session.js';

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
