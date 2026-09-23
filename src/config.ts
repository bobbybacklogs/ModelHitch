import type { CircuitBreakerOptions } from './core/circuit-breaker.js';
import type { MemoryLaneCooldownOptions } from './core/cooldown.js';
import type { LaneCooldown } from './core/failover.js';
import type { Policy, ProviderSource } from './core/policy.js';
import { validatePolicy } from './core/policy.js';
import { CircuitBreaker } from './core/circuit-breaker.js';
import { MemoryLaneCooldown } from './core/cooldown.js';
import type { CatalogSourceOptions } from './catalog/source.js';

/**
 * Milestone 5 — the serializable settings surface.
 *
 * `ModelHitchConfig` is the single local config document the settings UI
 * reads and writes. Everything here is plain JSON data; nothing imports
 * `node:*` (browser-safe). File I/O lives in `src/config-file.ts` (Node-only).
 *
 * The config separates WHAT the user configures from HOW the runtime is
 * built:
 * - `policy` — the trusted/fallback lane plan (JSON-safe from M1).
 * - `catalog` — the serializable subset of `CatalogSourceOptions`
 *   (`providers` = the allowlist picker, `baseUrls`, `baseUrl`, `ttlMs`).
 *   Runtime injectables (client, fetch, capabilities) are never serialized.
 * - `cooldown` — a JSON discriminator for the lane-health engine instead of
 *   a runtime instance.
 * - `keys` — per-provider API keys, persisted here so nothing requires
 *   digging through env vars; masked in every read API and in the UI.
 */

export interface CatalogConfig {
  /** Catalog provider allowlist — the "pick your providers" knob. */
  providers?: string[];
  /** BYO base URLs for catalog providers that lack a models.dev `api`. */
  baseUrls?: Record<string, string>;
  /** models.dev base URL (default "https://models.dev"). */
  baseUrl?: string;
  /** Catalog cache lifetime in ms (default 1h). */
  ttlMs?: number;
}

export type CooldownConfig =
  | ({ type: 'circuit-breaker' } & CircuitBreakerOptions)
  | ({ type: 'memory' } & MemoryLaneCooldownOptions);

/** Repository target for Cursor Cloud Agent runs. */
export interface CloudAgentRepoConfig {
  url: string;
  startingRef?: string;
}

/** Cursor Cloud Agent lane (disabled by default). */
export interface CloudAgentConfig {
  enabled: boolean;
  /** Model id from GET /v1/models (e.g. composer-2.5). */
  defaultModel?: string;
  /** Required unless exactly one connected repo is cached from the API. */
  repos?: CloudAgentRepoConfig[];
  mode?: 'agent' | 'plan';
  /** Locked false for Phase 1 — Cursor default branch/PR behavior only. */
  autoCreatePR?: false;
  workOnCurrentBranch?: boolean;
  sessionReuse?: 'per-request' | 'per-bridge-session' | 'sticky-until-idle';
}

export interface ImageGenerationConfig {
  /** Enable the dedicated image generation lane. Disabled by default. */
  enabled: boolean;
  /** Provider chosen for image generation; OpenAI is the default supported route. */
  providerId?: 'openai' | 'gemini';
  /** Model alias for the image lane. */
  model?: string;
  /** Preferred image quality. */
  quality?: 'low' | 'medium' | 'high';
  /** Preferred output size, e.g. `1024x1024`. */
  size?: string;
}

export interface ModelHitchConfig {
  /** Document version — currently 1. */
  version: 1;
  /** Default provider for bare model ids / requests without a provider. */
  defaultProviderId?: string;
  /** Default model when requests omit one. */
  defaultModel?: string;
  /** Trusted + fallback lane plan. */
  policy?: Policy;
  /** models.dev catalog mode (serializable subset). */
  catalog?: CatalogConfig;
  /** Lane-health engine: circuit breaker or memory cooldown. */
  cooldown?: CooldownConfig;
  /** Dedicated image-generation lane (kind of like a special failover lane). */
  imageGeneration?: ImageGenerationConfig;
  /** Cursor Cloud Agent lane (explicit cursor-cloud/… routes only). */
  cloudAgent?: CloudAgentConfig;
  /** Per-provider API keys. Persisted locally; masked on read. */
  keys?: Record<string, string>;
}

export interface ConfigValidation {
  errors: string[];
  warnings: string[];
}

export const CONFIG_VERSION = 1 as const;

/** A config with every secret value replaced by a masked hint. */
export interface MaskedConfig extends Omit<ModelHitchConfig, 'keys'> {
  keys?: Record<string, string>;
  _masked?: true;
}

/** `sk-abc123xyz` -> `••••••xyz` (keep the last 4 chars as a fingerprint). */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `••••••${value.slice(-4)}`;
}

/**
 * True when `value` looks like a masked placeholder we produced (and therefore
 * must never be persisted back as a real key). Protects the settings flow when
 * a client echoes a masked value back to the server.
 */
export function isMaskedSecret(value: string): boolean {
  return typeof value === 'string' && value.includes('••');
}

/** Deep-masked copy of the config for reads/UI (keys never leave the daemon). */
export function serializeConfig(config: ModelHitchConfig, opts: { maskSecrets?: boolean } = {}): ModelHitchConfig | MaskedConfig {
  if (!opts.maskSecrets) return JSON.parse(JSON.stringify(config)) as ModelHitchConfig;
  const { keys, ...rest } = config;
  const masked: MaskedConfig = { ...JSON.parse(JSON.stringify(rest)), _masked: true };
  if (keys) {
    const maskedKeys: Record<string, string> = {};
    for (const [providerId, value] of Object.entries(keys)) {
      maskedKeys[providerId] = maskSecret(value);
    }
    masked.keys = maskedKeys;
  }
  return masked;
}

/**
 * Structural validation only (types, shapes, discriminator, version). Full
 * provider-existence validation of `policy` happens at load time against the
 * real warmed source (registry or catalog) — see `ModelHitch.create()` /
 * the daemon bootstrap.
 */
export function validateConfig(config: unknown): ConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!config || typeof config !== 'object') {
    return { errors: ['Config must be an object.'], warnings };
  }
  const cfg = config as Partial<ModelHitchConfig>;

  if (cfg.version !== undefined && cfg.version !== CONFIG_VERSION) {
    errors.push(`Unsupported config version "${String(cfg.version)}" — this build expects version ${CONFIG_VERSION}.`);
  }

  if (cfg.defaultProviderId !== undefined && (typeof cfg.defaultProviderId !== 'string' || !cfg.defaultProviderId)) {
    errors.push('defaultProviderId must be a non-empty string.');
  }
  if (cfg.defaultModel !== undefined && (typeof cfg.defaultModel !== 'string' || !cfg.defaultModel)) {
    errors.push('defaultModel must be a non-empty string.');
  }

  if (cfg.policy !== undefined) {
    if (!cfg.policy || typeof cfg.policy !== 'object' || !Array.isArray(cfg.policy.trusted) || !Array.isArray(cfg.policy.fallback)) {
      errors.push('policy must have trusted[] and fallback[] arrays.');
    } else if (cfg.policy.trusted.length === 0 && cfg.policy.fallback.length === 0) {
      errors.push('policy must have at least one entry in trusted or fallback.');
    }
    if (cfg.policy?.maxProviders !== undefined && (!Number.isInteger(cfg.policy.maxProviders) || cfg.policy.maxProviders < 1)) {
      errors.push('policy.maxProviders must be a positive integer.');
    }
    if (cfg.policy?.backoff !== undefined) {
      const b = cfg.policy.backoff;
      if (b.type !== 'fixed' && b.type !== 'exponential') errors.push('policy.backoff.type must be "fixed" or "exponential".');
      if (typeof b.baseMs !== 'number' || b.baseMs < 0) errors.push('policy.backoff.baseMs must be a non-negative number.');
    }
  }

  if (cfg.catalog !== undefined) {
    const c = cfg.catalog;
    if (!c || typeof c !== 'object') {
      errors.push('catalog must be an object.');
    } else {
      if (c.providers !== undefined && (!Array.isArray(c.providers) || c.providers.some((p) => typeof p !== 'string'))) {
        errors.push('catalog.providers must be an array of provider ids.');
      }
      if (c.baseUrls !== undefined && (!c.baseUrls || typeof c.baseUrls !== 'object')) {
        errors.push('catalog.baseUrls must be an object of providerId -> base URL.');
      }
      if (c.ttlMs !== undefined && (!Number.isInteger(c.ttlMs) || c.ttlMs < 0)) {
        errors.push('catalog.ttlMs must be a non-negative integer.');
      }
    }
  }

  if (cfg.cooldown !== undefined) {
    const c = cfg.cooldown;
    if (!c || typeof c !== 'object' || (c.type !== 'circuit-breaker' && c.type !== 'memory')) {
      errors.push('cooldown must be { type: "circuit-breaker" | "memory", ... }.');
    } else {
      if (c.type === 'circuit-breaker') {
        if (c.failureThreshold !== undefined && (!Number.isInteger(c.failureThreshold) || c.failureThreshold < 1)) {
          errors.push('cooldown.failureThreshold must be a positive integer.');
        }
        for (const field of ['baseTripMs', 'maxTripMs', 'graceMs'] as const) {
          if (c[field] !== undefined && (typeof c[field] !== 'number' || c[field] < 0)) {
            errors.push(`cooldown.${field} must be a non-negative number.`);
          }
        }
        if (c.maxTripMs !== undefined && c.baseTripMs !== undefined && c.maxTripMs < c.baseTripMs) {
          errors.push('cooldown.maxTripMs must be >= cooldown.baseTripMs.');
        }
      }
    }
  }

  if (cfg.cloudAgent !== undefined) {
    const c = cfg.cloudAgent;
    if (!c || typeof c !== 'object') {
      errors.push('cloudAgent must be an object.');
    } else {
      if (typeof c.enabled !== 'boolean') errors.push('cloudAgent.enabled must be a boolean.');
      if (c.defaultModel !== undefined && (typeof c.defaultModel !== 'string' || !c.defaultModel.trim())) {
        errors.push('cloudAgent.defaultModel must be a non-empty string when set.');
      }
      if (c.repos !== undefined) {
        if (!Array.isArray(c.repos)) {
          errors.push('cloudAgent.repos must be an array.');
        } else {
          for (const [i, repo] of c.repos.entries()) {
            if (!repo || typeof repo !== 'object' || typeof repo.url !== 'string' || !repo.url.trim()) {
              errors.push(`cloudAgent.repos[${i}].url must be a non-empty string.`);
            }
            if (repo.startingRef !== undefined && (typeof repo.startingRef !== 'string' || !repo.startingRef.trim())) {
              errors.push(`cloudAgent.repos[${i}].startingRef must be a non-empty string when set.`);
            }
          }
        }
      }
      if (c.enabled && (!c.repos || c.repos.length === 0)) {
        warnings.push('cloudAgent.enabled is true but cloudAgent.repos is empty — a single connected repo may be used at runtime when cached.');
      }
      if (c.mode !== undefined && c.mode !== 'agent' && c.mode !== 'plan') {
        errors.push('cloudAgent.mode must be "agent" or "plan".');
      }
      if (c.autoCreatePR !== undefined && c.autoCreatePR !== false) {
        errors.push('cloudAgent.autoCreatePR must be false when set.');
      }
      if (
        c.sessionReuse !== undefined &&
        c.sessionReuse !== 'per-request' &&
        c.sessionReuse !== 'per-bridge-session' &&
        c.sessionReuse !== 'sticky-until-idle'
      ) {
        errors.push('cloudAgent.sessionReuse must be per-request, per-bridge-session, or sticky-until-idle.');
      }
    }
  }

  if (cfg.imageGeneration !== undefined) {
    const i = cfg.imageGeneration;
    if (!i || typeof i !== 'object') {
      errors.push('imageGeneration must be an object.');
    } else {
      if (typeof i.enabled !== 'boolean') errors.push('imageGeneration.enabled must be a boolean.');
      if (i.providerId !== undefined && !['openai', 'gemini'].includes(i.providerId)) {
        errors.push('imageGeneration.providerId must be either "openai" or "gemini".');
      }
      if (i.model !== undefined && (typeof i.model !== 'string' || !i.model.trim())) {
        errors.push('imageGeneration.model must be a non-empty string when set.');
      }
      if (i.quality !== undefined && !['low', 'medium', 'high'].includes(i.quality)) {
        errors.push('imageGeneration.quality must be "low", "medium", or "high".');
      }
      if (i.size !== undefined && (typeof i.size !== 'string' || !i.size.trim())) {
        errors.push('imageGeneration.size must be a non-empty string when set.');
      }
      if (i.providerId === 'openai' && i.model !== undefined && !['gpt-image-2', 'gpt-image-1.5'].includes(i.model)) {
        errors.push('OpenAI imageGeneration.model must be "gpt-image-2" or "gpt-image-1.5".');
      }
      if (i.providerId === 'openai' && i.model === 'gpt-image-1.5' && i.quality !== undefined && i.quality !== 'medium') {
        errors.push('gpt-image-1.5 is restricted to medium quality in the image lane.');
      }
      if (i.providerId === 'openai' && i.model === 'gpt-image-2' && i.quality === 'high') {
        errors.push('gpt-image-2 is restricted to low or medium quality in the image lane.');
      }
    }
  }

  if (cfg.keys !== undefined && (!cfg.keys || typeof cfg.keys !== 'object')) {
    errors.push('keys must be an object of providerId -> API key.');
  }

  return { errors, warnings };
}

/** Build the runtime cooldown engine from the serializable config. */
export function buildCooldownFromConfig(config: Pick<ModelHitchConfig, 'cooldown'>): LaneCooldown | undefined {
  const c = config.cooldown;
  if (!c) return undefined;
  if (c.type === 'circuit-breaker') {
    const { type: _t, ...options } = c;
    return new CircuitBreaker(options);
  }
  const { type: _t, ...options } = c;
  return new MemoryLaneCooldown(options);
}

/** Build the serializable catalog subset into `CatalogSourceOptions`. */
export function buildCatalogOptions(config: Pick<ModelHitchConfig, 'catalog'>): CatalogSourceOptions | undefined {
  const c = config.catalog;
  if (!c) return undefined;
  const options: CatalogSourceOptions = {};
  if (c.providers !== undefined) options.allow = c.providers;
  if (c.baseUrls !== undefined) options.baseUrls = c.baseUrls;
  if (c.baseUrl !== undefined) options.baseUrl = c.baseUrl;
  if (c.ttlMs !== undefined) options.ttlMs = c.ttlMs;
  return options;
}

/** Effective policy: config policy, or undefined (autoMode path). */
export function policyFromConfig(config: ModelHitchConfig): Policy | undefined {
  return config.policy;
}

/** Structural + (when a source is available) provider-aware policy validation. */
export function validateConfigWithSource(
  config: ModelHitchConfig,
  source?: ProviderSource,
): ConfigValidation {
  const base = validateConfig(config);
  if (source && config.policy) {
    const policy = validatePolicy(config.policy, source);
    base.errors.push(...policy.errors);
    base.warnings.push(...policy.warnings);
  }
  return base;
}