import type { CircuitBreakerOptions } from './core/circuit-breaker.js';
import type { MemoryLaneCooldownOptions } from './core/cooldown.js';
import type { LaneCooldown } from './core/failover.js';
import type { Policy, ProviderSource } from './core/policy.js';
import { validatePolicy } from './core/policy.js';
import { CircuitBreaker } from './core/circuit-breaker.js';
import { MemoryLaneCooldown } from './core/cooldown.js';
import type { CatalogSourceOptions } from './catalog/source.js';
import type { Capabilities } from './core/types.js';
import type { CustomLaneSchema } from './providers/custom-lane.js';
import { CUSTOM_LANE_SCHEMAS, customLaneProviderId } from './providers/custom-lane.js';
import type { OpenCodeByokSchema } from './providers/opencode-byok.js';
import { openCodeByokProviderId } from './providers/opencode-byok.js';

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

/**
 * One OpenCode Console BYOK connection (https://opencode.ai/v2/docs/console/byok/).
 *
 * Console stores a provider credential for the workspace and hands back exactly
 * one gateway URL per connection. ModelHitch serves each connection as its own
 * provider lane, so a connection can be rotated, pinned, cooled, and selected
 * with `bridge --provider <id>` like any built-in provider.
 *
 * Credentials deliberately live in `keys`, never here: `serializeConfig` masks
 * `keys` on every read, so a plaintext key in this block would leak through
 * `GET /v1/config`.
 */
export interface OpenCodeByokConnection {
  /** Console connection id (`conn_…`) or a full gateway URL. */
  id: string;
  /** Display label for the lane. */
  label?: string;
  /** Overrides the derived `https://opencode.ai/inference/custom/<id>` URL. */
  baseUrl?: string;
  /** Console API schema; `auto` (default) detects the wire from the model family. */
  schema?: OpenCodeByokSchema;
  /** Model ids enabled on the connection — the rotation pool. */
  models?: string[];
  /** Off = kept in the document but out of the provider set and out of rotation. */
  enabled?: boolean;
}

/** Rotation/pin policy for the Console BYOK connections. */
export interface OpenCodeByokConfig {
  /** Master switch. Off = no BYOK providers, no BYOK lanes. */
  enabled: boolean;
  /**
   * `rotation` spreads requests across every enabled connection + model;
   * `pinned` keeps the primary lane on one connection and uses the rest of the
   * plan only when it is depleted or erroring. Default: `rotation`.
   */
  mode?: 'rotation' | 'pinned';
  /** Connection pinned when `mode` is `pinned`. */
  pinnedConnectionId?: string;
  /** Model pinned when `mode` is `pinned`; defaults to the connection's first model. */
  pinnedModel?: string;
  /** Console BYOK connections. */
  connections: OpenCodeByokConnection[];
  /**
   * Seed empty connection model lists from the models the user actually runs in
   * their local OpenCode install (recent usage + auth/config), so the BYOK
   * rotation follows the OpenCode model choices instead of a guessed list.
   */
  syncFromOpenCode?: boolean;
}

/**
 * One custom BYOK lane: an endpoint ModelHitch does not ship, added by the user.
 *
 * These are hand-written slots, not a catalog. The `models` list is what the
 * user typed, and the bridge advertises exactly that — ModelHitch never polls
 * the endpoint for models, because an unknown provider's catalog is unknowable.
 *
 * Credentials deliberately live in `keys[providerId]` (or the lane's env var),
 * never here, exactly like `opencodeByok`: `serializeConfig` masks `keys` on
 * every read, so a plaintext key in this block would leak through
 * `GET /v1/config`.
 */
export interface CustomLaneConfig {
  /** Stable lane id — becomes the provider id `custom-<slug>`. */
  id: string;
  /** Display label for the lane. */
  label?: string;
  /** Endpoint root, e.g. `https://api.example.com/v1` (no trailing slash needed). */
  baseUrl: string;
  /** API schema; `auto` (default) detects the wire from the model family. */
  schema?: CustomLaneSchema;
  /** The model slots to route to. At least one is required. */
  models: string[];
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Env var holding the key; defaults to `MODELHITCH_CUSTOM_<SLUG>_API_KEY`. */
  apiKeyEnvVar?: string;
  /** False for a keyless endpoint (a self-hosted gateway). Default: true. */
  requiresKey?: boolean;
  /** Honest capability claims for an endpoint that cannot do tools/vision. */
  capabilities?: Partial<Capabilities>;
  /** Off = kept in the document but out of the provider set and out of rotation. */
  enabled?: boolean;
  /**
   * What happens when this lane is rate-limited or out of credit:
   * - `rotate` (default) fails over to the next lane, like every other lane.
   * - `stop` makes the lane terminal: the limit error surfaces to the caller
   *   instead of spending another provider, and it stays terminal while the
   *   lane is parked from that failure.
   */
  onLimit?: 'rotate' | 'stop';
}

/** Custom BYOK lanes: providers we don't ship, used as ordinary lanes. */
export interface CustomLanesConfig {
  /** Master switch. Off = no custom providers, no custom lanes. */
  enabled: boolean;
  /**
   * Where the lanes sit in the plan:
   * - `lead` (default) puts them at the front of `trusted`, with the configured
   *   policy directly behind as the safety net.
   * - `fallback` keeps the buffet primary and uses the custom lanes only when
   *   the configured lanes are depleted or erroring.
   */
  placement?: 'lead' | 'fallback';
  /** Custom lanes, in rotation order. */
  lanes: CustomLaneConfig[];
}

/**
 * Sign in with ChatGPT — the user's ChatGPT plan as a provider lane.
 *
 * The lane spends the plan the user authorized through `chatgpt.tokens.use
 * .direct`, so it is a *billing* choice as much as a routing one, and the
 * settings page asks for it with the approved "Continue with ChatGPT" button.
 *
 * Credentials never live here. Access, refresh, and ID tokens go in the
 * protected `chatgpt-plan.json` beside the config file (`0600`, written
 * atomically), and this block holds only routing preferences. That split is
 * what lets `GET /v1/config` keep masking secrets without special-casing a
 * second credential shape.
 *
 * OpenAI's preview route has rules the ordinary OpenAI API does not: every
 * request must set `store: false` and `stream: true`, history travels in
 * `input`, and a list of fields is rejected outright. See
 * `src/providers/chatgpt-plan.ts`.
 */
export interface ChatGptPlanConfig {
  /** Master switch. Off = no lane, no provider, and no sign-in routes needed. */
  enabled: boolean;
  /**
   * `rotation` spreads requests across the model slots (and the plan's shared
   * usage total, which is what a Plus account is really rotating over);
   * `pinned` makes one model the main route and keeps the rest directly behind
   * it as the first fallback. Default: `rotation`.
   */
  mode?: 'rotation' | 'pinned';
  /**
   * Where the lane sits in the plan:
   * - `lead` (default) puts the lane at the front of `trusted`, so eligible
   *   requests spend the ChatGPT plan first.
   * - `fallback` appends it to `fallback`, so it is used only once the
   *   configured lanes are depleted or erroring.
   */
  placement?: 'lead' | 'fallback';
  /**
   * Model slugs the lane serves, in rotation order. Empty means "ask the
   * signed-in account" — the bridge reads `GET /v1/models` at startup, and the
   * settings page fills this in with the account's picker. ModelHitch never
   * invents a slug, because the catalog is account-specific.
   */
  models?: string[];
  /** Model that leads when `mode` is `pinned`. Must be one of `models`. */
  pinnedModel?: string;
  /** Which saved ChatGPT account serves this lane. Default: the active one. */
  accountKey?: string;
  /**
   * What a ChatGPT plan limit means:
   * - `rotate` (default) tries the next lane, exactly like any other 429. The
   *   lane cools down, so later requests skip it until it recovers.
   * - `stop` makes the lane terminal, so a spent plan surfaces to the caller
   *   instead of silently spending a different provider's quota.
   */
  onLimit?: 'rotate' | 'stop';
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
  /** OpenCode Console BYOK connections (one provider lane each). */
  opencodeByok?: OpenCodeByokConfig;
  /** Custom BYOK lanes — endpoints we don't ship, with hand-typed model slots. */
  customLanes?: CustomLanesConfig;
  /** Sign in with ChatGPT — the user's ChatGPT plan as a provider lane. */
  chatgptPlan?: ChatGptPlanConfig;
  /** Per-provider API keys. Persisted locally; masked on read. */
  keys?: Record<string, string>;
  /** Default composer target on /workspace: "rotation" or "provider/model". */
  defaultWorkspaceTarget?: string;
}

export interface ConfigValidation {
  errors: string[];
  warnings: string[];
}

export const CONFIG_VERSION = 1 as const;

/** Console API schemas accepted by `opencodeByok.connections[].schema`. */
export const OPENCODE_BYOK_SCHEMAS: readonly OpenCodeByokSchema[] = ['auto', 'chat-completions', 'responses', 'anthropic', 'google'];

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

  if (cfg.opencodeByok !== undefined) {
    const b = cfg.opencodeByok;
    if (!b || typeof b !== 'object') {
      errors.push('opencodeByok must be an object.');
    } else {
      if (typeof b.enabled !== 'boolean') errors.push('opencodeByok.enabled must be a boolean.');
      if (b.mode !== undefined && b.mode !== 'rotation' && b.mode !== 'pinned') {
        errors.push('opencodeByok.mode must be "rotation" or "pinned".');
      }
      if (b.syncFromOpenCode !== undefined && typeof b.syncFromOpenCode !== 'boolean') {
        errors.push('opencodeByok.syncFromOpenCode must be a boolean.');
      }
      if (b.connections !== undefined && !Array.isArray(b.connections)) {
        errors.push('opencodeByok.connections must be an array.');
      } else {
        const seenIds = new Set<string>();
        for (const [i, connection] of (b.connections ?? []).entries()) {
          const label = `opencodeByok.connections[${i}]`;
          if (!connection || typeof connection !== 'object' || typeof connection.id !== 'string' || !connection.id.trim()) {
            errors.push(`${label}.id must be a non-empty connection id or gateway URL.`);
            continue;
          }
          const laneId = openCodeByokProviderId(connection.id, connection.label);
          if (seenIds.has(laneId)) {
            errors.push(`${label}: connection "${connection.id}" collides with another connection (both become provider "${laneId}").`);
          }
          seenIds.add(laneId);
          if (connection.label !== undefined && (typeof connection.label !== 'string' || !connection.label.trim())) {
            errors.push(`${label}.label must be a non-empty string when set.`);
          }
          if (connection.baseUrl !== undefined && (typeof connection.baseUrl !== 'string' || !connection.baseUrl.trim())) {
            errors.push(`${label}.baseUrl must be a non-empty URL when set.`);
          }
          if (connection.schema !== undefined && !OPENCODE_BYOK_SCHEMAS.includes(connection.schema)) {
            errors.push(`${label}.schema must be one of ${OPENCODE_BYOK_SCHEMAS.join(', ')}.`);
          }
          if (connection.models !== undefined) {
            if (!Array.isArray(connection.models) || connection.models.some((m) => typeof m !== 'string' || !m.trim())) {
              errors.push(`${label}.models must be an array of non-empty model ids.`);
            }
          }
          if (connection.enabled !== undefined && typeof connection.enabled !== 'boolean') {
            errors.push(`${label}.enabled must be a boolean.`);
          }
        }
        const usable = (b.connections ?? []).filter((c) => c && c.enabled !== false && typeof c?.id === 'string' && c.id.trim());
        if (b.enabled && usable.length === 0) {
          warnings.push('opencodeByok.enabled is true but no connection is enabled — the bridge will not serve any BYOK lane.');
        }
        if (b.mode === 'pinned') {
          if (!b.pinnedConnectionId) {
            errors.push('opencodeByok.mode is "pinned" but opencodeByok.pinnedConnectionId is not set.');
          } else if (!usable.some((c) => c.id === b.pinnedConnectionId)) {
            errors.push(`opencodeByok.pinnedConnectionId "${b.pinnedConnectionId}" does not match an enabled connection.`);
          }
        }
        if (b.pinnedModel !== undefined && (typeof b.pinnedModel !== 'string' || !b.pinnedModel.trim())) {
          errors.push('opencodeByok.pinnedModel must be a non-empty model id when set.');
        }
      }
      if (b.enabled && b.connections !== undefined && !(b.connections ?? []).some((c) => (c?.models ?? []).length > 0) && !b.syncFromOpenCode) {
        warnings.push('opencodeByok connections have no models and syncFromOpenCode is off — each lane will fall back to the provider default model.');
      }
    }
  }

  if (cfg.customLanes !== undefined) {
    const c = cfg.customLanes;
    if (!c || typeof c !== 'object') {
      errors.push('customLanes must be an object.');
    } else {
      if (typeof c.enabled !== 'boolean') errors.push('customLanes.enabled must be a boolean.');
      if (c.placement !== undefined && c.placement !== 'lead' && c.placement !== 'fallback') {
        errors.push('customLanes.placement must be "lead" or "fallback".');
      }
      if (c.lanes !== undefined && !Array.isArray(c.lanes)) {
        errors.push('customLanes.lanes must be an array.');
      }
      const seenLaneIds = new Set<string>();
      for (const [i, lane] of (c.lanes ?? []).entries()) {
        const label = `customLanes.lanes[${i}]`;
        if (!lane || typeof lane !== 'object' || typeof lane.id !== 'string' || !lane.id.trim()) {
          errors.push(`${label}.id must be a non-empty lane id.`);
          continue;
        }
        const providerId = customLaneProviderId(lane.id, lane.label);
        if (seenLaneIds.has(providerId)) {
          errors.push(`${label}: lane "${lane.id}" collides with another lane (both become provider "${providerId}").`);
        }
        seenLaneIds.add(providerId);
        if (lane.label !== undefined && (typeof lane.label !== 'string' || !lane.label.trim())) {
          errors.push(`${label}.label must be a non-empty string when set.`);
        }
        if (typeof lane.baseUrl !== 'string' || !lane.baseUrl.trim()) {
          errors.push(`${label}.baseUrl must be a non-empty endpoint URL.`);
        } else if (!/^https?:\/\//i.test(lane.baseUrl.trim())) {
          errors.push(`${label}.baseUrl must start with http:// or https:// (got "${lane.baseUrl.trim()}").`);
        }
        if (lane.schema !== undefined && !CUSTOM_LANE_SCHEMAS.includes(lane.schema)) {
          errors.push(`${label}.schema must be one of ${CUSTOM_LANE_SCHEMAS.join(', ')}.`);
        }
        // A lane exists to route to models the user names. There is no catalog
        // to fall back on, so an empty slot list is a hard error rather than a
        // silent "provider default" that does not exist.
        if (!Array.isArray(lane.models) || lane.models.length === 0) {
          errors.push(`${label}.models must list at least one model id.`);
        } else if (lane.models.some((m) => typeof m !== 'string' || !m.trim())) {
          errors.push(`${label}.models must be an array of non-empty model ids.`);
        } else if (new Set(lane.models.map((m) => m.trim())).size !== lane.models.length) {
          warnings.push(`${label}.models contains duplicate model ids — duplicates are ignored.`);
        }
        if (lane.headers !== undefined) {
          if (!lane.headers || typeof lane.headers !== 'object' || Array.isArray(lane.headers)) {
            errors.push(`${label}.headers must be an object of header name -> value.`);
          } else if (Object.values(lane.headers).some((v) => typeof v !== 'string')) {
            errors.push(`${label}.headers values must be strings.`);
          }
        }
        if (lane.apiKeyEnvVar !== undefined && (typeof lane.apiKeyEnvVar !== 'string' || !lane.apiKeyEnvVar.trim())) {
          errors.push(`${label}.apiKeyEnvVar must be a non-empty env var name when set.`);
        }
        if (lane.requiresKey !== undefined && typeof lane.requiresKey !== 'boolean') {
          errors.push(`${label}.requiresKey must be a boolean.`);
        }
        if (lane.enabled !== undefined && typeof lane.enabled !== 'boolean') {
          errors.push(`${label}.enabled must be a boolean.`);
        }
        if (lane.capabilities !== undefined && (!lane.capabilities || typeof lane.capabilities !== 'object')) {
          errors.push(`${label}.capabilities must be an object of capability overrides.`);
        }
        if (lane.onLimit !== undefined && lane.onLimit !== 'rotate' && lane.onLimit !== 'stop') {
          errors.push(`${label}.onLimit must be "rotate" or "stop".`);
        }
        if (lane.requiresKey === false && lane.schema === 'anthropic') {
          warnings.push(`${label}: the Anthropic wire still expects a key — requiresKey:false has no effect there.`);
        }
      }

      const usable = (c.lanes ?? []).filter(
        (lane) => lane && lane.enabled !== false && typeof lane?.id === 'string' && !!lane.id.trim() && (lane.models ?? []).length > 0,
      );
      if (c.enabled && usable.length === 0) {
        warnings.push('customLanes.enabled is true but no lane is complete — the bridge will not serve any custom lane.');
      }
      // A `stop` lane ends the rotation for everything behind it; say so rather
      // than let the user wonder why their later lanes never get traffic.
      const stopping = usable.filter((lane) => lane.onLimit === 'stop');
      for (const lane of stopping) {
        const index = usable.indexOf(lane);
        if (index !== -1 && index < usable.length - 1) {
          warnings.push(
            `customLanes: lane "${lane.id}" is onLimit:"stop" but ${usable.length - 1 - index} lane(s) follow it — those are only reached when routed to explicitly.`,
          );
        }
      }
    }
  }

  if (cfg.chatgptPlan !== undefined) {
    const c = cfg.chatgptPlan;
    if (!c || typeof c !== 'object') {
      errors.push('chatgptPlan must be an object.');
    } else {
      if (typeof c.enabled !== 'boolean') errors.push('chatgptPlan.enabled must be a boolean.');
      if (c.mode !== undefined && c.mode !== 'rotation' && c.mode !== 'pinned') {
        errors.push('chatgptPlan.mode must be "rotation" or "pinned".');
      }
      if (c.placement !== undefined && c.placement !== 'lead' && c.placement !== 'fallback') {
        errors.push('chatgptPlan.placement must be "lead" or "fallback".');
      }
      if (c.onLimit !== undefined && c.onLimit !== 'rotate' && c.onLimit !== 'stop') {
        errors.push('chatgptPlan.onLimit must be "rotate" or "stop".');
      }
      if (c.accountKey !== undefined && (typeof c.accountKey !== 'string' || !c.accountKey.trim())) {
        errors.push('chatgptPlan.accountKey must be a non-empty string when set.');
      }
      if (c.models !== undefined) {
        if (!Array.isArray(c.models) || c.models.some((m) => typeof m !== 'string' || !m.trim())) {
          errors.push('chatgptPlan.models must be an array of non-empty model slugs.');
        } else if (new Set(c.models.map((m) => m.trim())).size !== c.models.length) {
          warnings.push('chatgptPlan.models contains duplicate model slugs — duplicates are ignored.');
        }
      }
      if (c.pinnedModel !== undefined && (typeof c.pinnedModel !== 'string' || !c.pinnedModel.trim())) {
        errors.push('chatgptPlan.pinnedModel must be a non-empty model slug when set.');
      }
      // `models` may be malformed at this point (the check above only reports
      // it), so the derived list stays empty rather than throwing: a validator
      // that crashes on bad input is worse than one that rejects it.
      const models = (Array.isArray(c.models) ? c.models : [])
        .filter((m): m is string => typeof m === 'string')
        .map((m) => m.trim())
        .filter(Boolean);
      if (c.mode === 'pinned') {
        if (!c.pinnedModel) {
          warnings.push('chatgptPlan.mode is "pinned" without chatgptPlan.pinnedModel — the first model slot leads.');
        } else if (models.length && !models.includes(c.pinnedModel.trim())) {
          errors.push(
            `chatgptPlan.pinnedModel "${c.pinnedModel.trim()}" is not one of chatgptPlan.models — the lane would route to a model it does not serve.`,
          );
        }
      }
      if (c.enabled && !models.length) {
        warnings.push(
          'chatgptPlan.enabled is true but chatgptPlan.models is empty — the bridge reads the signed-in account\'s model list at startup, and the lane serves nothing until an account is signed in.',
        );
      }
    }
  }

  if (cfg.defaultWorkspaceTarget !== undefined) {
    if (typeof cfg.defaultWorkspaceTarget !== 'string' || !cfg.defaultWorkspaceTarget.trim()) {
      errors.push('defaultWorkspaceTarget must be a non-empty string.');
    } else if (cfg.defaultWorkspaceTarget !== 'rotation') {
      const slash = cfg.defaultWorkspaceTarget.indexOf('/');
      if (slash <= 0 || slash === cfg.defaultWorkspaceTarget.length - 1) {
        errors.push('defaultWorkspaceTarget must be "rotation" or "provider/model".');
      }
    }
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