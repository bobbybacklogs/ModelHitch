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
  type MaskedConfig,
  type ModelHitchConfig,
} from './config.js';

export { UsageTracker, usageDashboardHtml } from './core/usage.js';
// `UsageStorage` is an interface only — safe for browsers. `SqliteUsageStorage`
// (the Node `node:sqlite` implementation) stays Node-only and is not exported
// here.
export type { UsageStorage } from './core/usage-storage.js';
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
  // OpenCode Zen & Go
  opencodeZen,
  opencodeGo,
  createOpenCodeZenProvider,
  createOpenCodeGoProvider,
  OPENCODE_ZEN_MODELS,
  OPENCODE_GO_MODELS,
  // Native OpenCode Zen protocol adapters
  zenResponses,
  zenMessages,
  zenGemini,
  createZenResponsesProvider,
  ZenResponsesProvider,
  type ZenResponsesProviderOptions,
  createZenMessagesProvider,
  type ZenMessagesProviderOptions,
  createZenGeminiProvider,
  ZenGeminiProvider,
  type ZenGeminiProviderOptions,
  zenProtocolForModel,
  type ZenProtocol,
  // Default providers
  openai,
  anthropic,
  groq,
  openrouter,
  vercelAiGateway,
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
