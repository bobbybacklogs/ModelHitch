// ModelHitch — plug-and-play BYOK integration layer.
// Hitch any model to your app: one interface, user-supplied providers & keys.

export { ModelHitch, type ModelHitchOptions, type ChatInput } from './client.js';
export { ASCII_LOGO, printAsciiLogo } from './ascii.js';
export {
  runToolLoop,
  type BatchToolExecutor,
  type HistoryRewriter,
  type ToolExecutor,
  type ToolLoopOptions,
  type ToolLoopEvent,
} from './agent.js';
export { defaultProviders } from './registry.js';
export { MemoryKeyStore } from './storage/memory.js';
export { LocalStorageKeyStore } from './storage/local-storage.js';

// OpenAI-compatible bridge server (agentic IDEs: Android Studio, JetBrains, ...)
export { OpenAICompatibleServer, createModelHitchServer } from './server/server.js';
export type { ModelHitchServerOptions } from './server/server.js';

// the bridge's routing plan as pickable models (`GET /v1/models` lane entries)
export {
  displayModelName,
  laneLabel,
  laneRoute,
  planLanes,
  planModelEntries,
  providerDisplayName,
  type PlanLane,
  type PlanLanesInput,
  type PlanModelEntriesOptions,
  type PlanModelEntry,
  type PlanTier,
} from './server/lane-catalog.js';

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
export {
  OPENAI_COMPAT_GATEWAY_CATALOG_DEFAULT_MAX_TOKENS,
  OPENAI_COMPAT_MAX_TOKENS_CEILING,
  OPENAI_COMPAT_SAFE_DEFAULT_MAX_TOKENS,
  resolveOpenAICompatMaxTokens,
  type ResolveOpenAICompatMaxTokensOptions,
} from './core/max-tokens.js';

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
  OPENCODE_BYOK_SCHEMAS,
  type CatalogConfig,
  type CooldownConfig,
  type ConfigValidation,
  type CustomLaneConfig,
  type CustomLanesConfig,
  type ImageGenerationConfig,
  type MaskedConfig,
  type ModelHitchConfig,
  type OpenCodeByokConfig,
  type OpenCodeByokConnection,
} from './config.js';
export { defaultConfigTemplate, initConfigFile, readConfigFile, writeConfigFile } from './config-file.js';

// OpenCode Console BYOK — one provider lane per Console connection
export {
  applyOpenCodeByokPlan,
  describeOpenCodeByokPlan,
  isOpenCodeByokEnabled,
  isOpenCodeByokLane,
  openCodeByokApiKeys,
  openCodeByokConfig,
  openCodeByokModels,
  openCodeByokProviders,
  openCodeModelsForConnection,
  resolveOpenCodeByokConnections,
  type OpenCodeByokPlan,
  type OpenCodeByokPlanInput,
  type OpenCodeByokProviderOptions,
  type OpenCodeLocalProvider,
  type OpenCodeLocalState,
  type ResolvedOpenCodeByokConnection,
} from './opencode-byok.js';
export {
  openCodeConfigDirs,
  openCodeDataDirs,
  parseJsonc,
  readOpenCodeLocalState,
  type OpenCodeStateOptions,
} from './opencode-state.js';

// Custom BYOK lanes — endpoints we don't ship, with hand-typed model slots
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

// Sign in with ChatGPT — the user's ChatGPT plan as an ordinary provider lane
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
  CHATGPT_PLAN_AGENT_NAME,
  CHATGPT_PLAN_API_BASE_URL,
  CHATGPT_PLAN_AUTHORIZE_ENDPOINT,
  CHATGPT_PLAN_CALLBACK_HOST,
  CHATGPT_PLAN_CALLBACK_PATH,
  CHATGPT_PLAN_DEFAULT_CALLBACK_PORT,
  CHATGPT_PLAN_DISCOVERY_URL,
  CHATGPT_PLAN_DYNAMIC_CLIENT_ID,
  CHATGPT_PLAN_ERRORS_URL,
  CHATGPT_PLAN_IDENTITY_SCOPES,
  CHATGPT_PLAN_ISSUER,
  CHATGPT_PLAN_PROVIDER_ID,
  CHATGPT_PLAN_PROVIDER_NAME,
  CHATGPT_PLAN_REFRESH_TOKEN_LIFETIME_MS,
  CHATGPT_PLAN_RESOURCE,
  CHATGPT_PLAN_REVOCATION_ENDPOINT,
  CHATGPT_PLAN_SCOPES,
  CHATGPT_PLAN_SIGN_IN_TIMEOUT_MS,
  CHATGPT_PLAN_TOKEN_ENDPOINT,
  CHATGPT_PLAN_TOKEN_SKEW_MS,
  CHATGPT_PLAN_USAGE_SCOPE,
  CHATGPT_PLAN_USAGE_SCOPES,
  CHATGPT_PLAN_USAGE_SETTINGS_URL,
  type ChatGptPlanAccount,
  type ChatGptPlanAccountStatus,
  type ChatGptPlanCredentials,
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
// Node-only half of the lane: OAuth PKCE, the loopback callback listener,
// JWKS-backed ID-token validation, and the protected credential file.
export {
  ChatGptPlanAuth,
  buildChatGptPlanAuthorizeUrl,
  createHostId,
  createPkcePair,
  createRandomValue,
  defaultChatGptPlanCredentialsPath,
  describeChatGptPlanAccount,
  isValidHostId,
  openInBrowser,
  pkceChallenge,
  readChatGptPlanCredentials,
  redactAuthorizeUrl,
  validateChatGptPlanIdToken,
  writeChatGptPlanCredentials,
  DEFAULT_CHATGPT_PLAN_ENDPOINTS,
  type ChatGptPlanAuthOptions,
  type ChatGptPlanEndpoints,
  type BuildAuthorizeUrlInput,
  type PkcePair,
  type ValidatedIdToken,
  type ValidateIdTokenInput,
} from './chatgpt-plan-auth.js';

export { UsageTracker, usageDashboardHtml } from './core/usage.js';
export { SqliteUsageStorage, type UsageStorage } from './core/usage-storage.js';
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
  resolveOutboundSessionId,
  SESSION_HEADER_CANDIDATES,
} from './core/session.js';

export {
  DsmlStreamGuard,
  hasDsmlMarkup,
  hasToolCallMarkup,
  recoverDsmlToolCalls,
  recoverMessageToolCalls,
  toolSchemaFromDefinitions,
} from './core/dsml.js';

export type { DsmlRecovery, RecoveredToolCall, ToolSchemaMap } from './core/dsml.js';

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
