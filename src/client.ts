import type { KeyStore } from './core/keystore.js';
import type {
  Capabilities,
  ChatParams,
  ChatResult,
  ProviderCredentials,
  StreamChunk,
} from './core/types.js';
import type { ModelInfo, Provider } from './providers/types.js';
import { MemoryLaneCooldown } from './core/cooldown.js';
import {
  createRegistrySource,
  resolvePolicyLanes,
  validatePolicy,
  computeBackoffDelay,
  type Policy,
  type ProviderSource,
} from './core/policy.js';
import { createCatalogSource, type CatalogSource, type CatalogSourceOptions } from './catalog/source.js';
import { CircuitBreaker, type LaneHealth } from './core/circuit-breaker.js';
import { ModelHitchError, type ModelHitchErrorCode } from './core/errors.js';
import { aggregateStream } from './core/stream.js';
import {
  inferRequirements,
  filterEligibleLanes,
  CapabilityUnavailableError,
  type CapabilityRequirements,
} from './core/capabilities.js';
import { defaultProviders } from './registry.js';
import {
  DEFAULT_RETRYABLE_CODES,
  resolveLanes,
  retryableCodesFor,
  maxAttemptsFor,
  withFailover,
  withFailoverStream,
  type AutoModeOptions,
  type ExhaustionInfo,
  type FailoverEvent,
  type FailoverTarget,
  type LaneCooldown,
} from './core/failover.js';

export interface ModelHitchOptions {
  /** Providers to use. Defaults to the built-in set. */
  providers?: Provider[];
  /** Where end-user API keys live (optional — pass keys per-call instead). */
  keystore?: KeyStore;
  /** Default provider used when calls don't specify one. */
  defaultProviderId?: string;
  /** Default model used when calls don't specify one (falls back to provider default). */
  defaultModel?: string;
  /**
   * auto-mode: transparent failover when the primary lane errors (429 rate
   * limits, 5xx, network blips). `true` uses the default fallback lineup
   * (alternate Vercel AI Gateway models, then OpenAI); pass `AutoModeOptions`
   * for custom lanes/models. Keys for fallback lanes resolve from the keystore
   * (or the provider's own env fallback) — per-call `apiKey`/`baseUrl` stay with
   * the primary provider.
   */
  autoMode?: AutoModeOptions | boolean;
  /**
   * Policy-driven routing (Milestone 1). The lane is the meaningful trust
   * object: `trusted` + `fallback` entries expand into an ordered failover
   * target list. Higher-level than `autoMode` — configure one or the other,
   * never both. Disabling `backoff` keeps failover instant (default); the
   * optional `backoff` opts into waiting before a lane switch.
   */
  policy?: Policy;
  /**
   * models.dev catalog mode (Milestone 2). Consumes mdev-sdk: the catalog
   * supplies the full model inventory, costs, and env var names; ModelHitch's
   * registry stays the curated executable layer, and catalog-only providers
   * with an API URL get auto-built OpenAI-compatible adapters. Requires
   * `ModelHitch.create()` — the catalog must be fetched before first use.
   */
  catalog?: CatalogSourceOptions;
  /**
   * Lane-health memory used by policy mode. Defaults to `MemoryLaneCooldown`
   * (cool on failure, Retry-After aware) for registry mode and
   * `CircuitBreaker` (thresholds + escalation + half-open) for catalog mode.
   * Pass your own to tune either. Only applies in policy mode (autoMode has
   * no lane memory by design).
   */
  cooldown?: LaneCooldown;
  /**
   * Called when auto-mode walks every lane and the work stops — the
   * "limited on all endpoints" signal, with per-lane failure diagnostics.
   */
  onExhausted?: (info: ExhaustionInfo) => void;
  /** Called each time auto-mode switches lanes. */
  onFailover?: (event: FailoverEvent) => void;
}

export type ChatInput = Omit<ChatParams, 'model'> & {
  /** Model id; defaults to the client's `defaultModel` or the provider default. */
  model?: string;
  /** Provider id, e.g. "vercel-ai-gateway" or "anthropic". */
  provider?: string;
  /** Explicit credentials for this call (overrides the keystore). */
  apiKey?: string;
  baseUrl?: string;
};

function isCatalogSource(source: ProviderSource): source is CatalogSource {
  return (source as Partial<CatalogSource>).kind === 'catalog';
}

/**
 * In catalog mode, a policy that names a *known* catalog provider that simply
 * isn't callable yet (no API URL, filtered out) deserves a better error than
 * "unknown provider". Expand those into actionable guidance.
 */
function improvePolicyErrors(errors: string[], source: ProviderSource): string[] {
  if (!isCatalogSource(source)) return errors;
  return errors.map((error) => {
    const match = /unknown provider "([^"]+)"/.exec(error);
    if (!match) return error;
    const id = match[1]!;
    const reason = source.usabilityReason(id);
    if (reason === undefined) return error;
    return `provider "${id}" is in the models.dev catalog but not callable yet: ${reason}`;
  });
}

/**
 * ModelHitch — the BYOK integration layer.
 *
 * ```ts
 * const mh = new ModelHitch({ keystore: myKeyStore });
 * const result = await mh.chat({ provider: 'vercel-ai-gateway', messages: [{ role: 'user', content: 'hi' }] });
 * ```
 *
 * Catalog mode (models.dev via mdev-sdk) is async — the catalog must be
 * fetched before first use — so catalog-enabled instances are built with
 * `await ModelHitch.create({ catalog, policy })` instead of `new`.
 */
export class ModelHitch {
  readonly providers: Provider[];
  readonly keystore?: KeyStore;
  readonly defaultProviderId?: string;
  readonly defaultModel?: string;
  readonly autoMode?: AutoModeOptions | boolean;
  readonly policy?: Policy;
  readonly onFailover?: (event: FailoverEvent) => void;
  readonly onExhausted?: (info: ExhaustionInfo) => void;
  /** Lane cooldown state shared across calls (policy mode). */
  readonly cooldown?: LaneCooldown;
  /** Where lane targets come from: the registry source, or the catalog source in catalog mode. */
  readonly source: ProviderSource;

  /** @internal The `source` overload is used by `ModelHitch.create()` after warming the catalog. */
  constructor(options: ModelHitchOptions = {}, internal: { source?: ProviderSource } = {}) {
    const providedSource = internal.source;
    this.providers = providedSource ? providedSource.providers() : options.providers ?? defaultProviders;
    this.keystore = options.keystore;
    this.defaultProviderId = options.defaultProviderId;
    this.defaultModel = options.defaultModel;
    this.autoMode = options.autoMode;
    this.onFailover = options.onFailover;
    this.onExhausted = options.onExhausted;

    if (providedSource) {
      this.source = providedSource;
    } else {
      if (options.catalog) {
        throw new ModelHitchError(
          'bad-request',
          'Catalog mode requires ModelHitch.create() — the models.dev catalog must be fetched before first use. ' +
            'Use `await ModelHitch.create({ catalog, policy })` instead of `new ModelHitch(...)`.',
          {},
        );
      }
      this.source = createRegistrySource(this.providers);
    }

    if (options.policy && options.autoMode) {
      throw new ModelHitchError(
        'bad-request',
        'Configure either "policy" or "autoMode", not both. Policy is the higher-level replacement.',
        {},
      );
    }
    this.policy = options.policy;
    if (this.policy) {
      const { errors } = validatePolicy(this.policy, this.source);
      if (errors.length) {
        throw new ModelHitchError('bad-request', `Invalid policy:\n- ${improvePolicyErrors(errors, this.source).join('\n- ')}`, {});
      }
      // Catalog mode defaults to the circuit breaker (dynamic lane counts make
      // walking known-dead endpoints expensive); registry mode keeps the
      // simpler Retry-After-aware cooldown. Explicit options always win.
      this.cooldown =
        options.cooldown ?? (isCatalogSource(this.source) ? new CircuitBreaker() : new MemoryLaneCooldown());
    }
  }

  /**
   * Build a ModelHitch. In catalog mode this warms the models.dev catalog
   * (via mdev-sdk), merges it with the registry (registry providers win on
   * id conflicts), and validates the policy against the merged set.
   */
  static async create(options: ModelHitchOptions = {}): Promise<ModelHitch> {
    if (!options.catalog) return new ModelHitch(options);
    const catalog: CatalogSource = createCatalogSource({
      ...options.catalog,
      registry: options.providers ?? defaultProviders,
    });
    try {
      await catalog.warm();
    } catch (err) {
      // Keep mdev-sdk's foreign ModelsDevError out of the public contract.
      if (err instanceof ModelHitchError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new ModelHitchError('network-error', `Failed to fetch the models.dev catalog: ${message}`, {
        cause: err,
      });
    }
    return new ModelHitch(options, { source: catalog });
  }

  /** The catalog source when this instance was created in catalog mode. */
  get catalogSource(): CatalogSource | undefined {
    return isCatalogSource(this.source) ? this.source : undefined;
  }

  /**
   * Per-lane health for the settings/dashboard UI. Returns the circuit
   * breaker's snapshot when a breaker is active (catalog mode by default)
   * and an empty list otherwise (memory cooldown tracks no health state).
   */
  get laneHealth(): LaneHealth[] {
    return this.cooldown instanceof CircuitBreaker ? this.cooldown.snapshot() : [];
  }

  /** Look up a provider by id. Throws `provider-not-found` if unknown. */
  provider(id: string): Provider {
    const p = this.providers.find((p) => p.id === id);
    if (!p) {
      const known = this.providers.map((p) => p.id).join(', ');
      throw new ModelHitchError('provider-not-found', `Unknown provider "${id}". Available: ${known}`, {
        providerId: id,
      });
    }
    return p;
  }

  private resolveProvider(input: ChatInput): Provider {
    const id = input.provider ?? this.defaultProviderId ?? this.providers[0]?.id;
    if (!id) throw new ModelHitchError('provider-not-found', 'No providers registered.', {});
    return this.provider(id);
  }

  private resolveModel(provider: Provider, input: ChatInput): string {
    return input.model ?? this.defaultModel ?? provider.defaultModel;
  }

  /** Resolve credentials: explicit > keystore > (adapter env var fallback). */
  private async resolveCredentials(
    provider: Provider,
    input: ChatInput,
  ): Promise<ProviderCredentials> {
    const explicit: ProviderCredentials = {};
    if (input.apiKey) explicit.apiKey = input.apiKey;
    if (input.baseUrl) explicit.baseUrl = input.baseUrl;
    if (explicit.apiKey || explicit.baseUrl) return explicit;
    if (this.keystore) {
      const apiKey = await this.keystore.get(provider.id);
      if (apiKey) return { apiKey };
    }
    return {};
  }

  private buildParams(input: ChatInput, provider: Provider): ChatParams {
    const { provider: _p, apiKey: _k, baseUrl: _b, model, ...rest } = input;
    return { ...rest, model: this.resolveModel(provider, input) };
  }

  /** Ordered lane list: the primary first, then policy/auto-mode fallbacks. */
  private failoverTargets(providerId: string, model: string): FailoverTarget[] {
    const primary: FailoverTarget = { providerId, model };
    if (this.policy) return resolvePolicyLanes(this.policy, primary, this.source);
    return [primary, ...resolveLanes(primary, this.autoMode)];
  }

  /**
   * Drop lanes whose provider can't meet the request's inferred requirements
   * (tool calling, vision, ...) before failover ever attempts them — a
   * capability mismatch is a routing decision, not a runtime failure, so
   * skipped lanes never cool down and never count against a provider.
   */
  private capableTargets(
    targets: FailoverTarget[],
    req: CapabilityRequirements,
  ): FailoverTarget[] {
    const { eligible, skipped } = filterEligibleLanes(targets, req, (t) => this.source.lookup(t.providerId)?.capabilities);
    if (eligible.length === 0) throw new CapabilityUnavailableError(req, skipped);
    return eligible;
  }

  /**
   * Opt-in delay before a lane switch (policy.backoff). Returns ms to wait or
   * undefined for instant. Waiting is bounded politeness: Retry-After is used
   * as the floor up to the user's `maxMs` cap — the cap wins, because opting
   * into backoff means "wait a little, then move on", never "sit out the full
   * rate-limit window".
   */
  private delayBeforeFailover(_from: FailoverTarget, err: unknown, attempt: number): number | undefined {
    return computeBackoffDelay(this.policy?.backoff, err, attempt);
  }

  private failoverContext(opts: AutoModeOptions | boolean | undefined, targets: FailoverTarget[]): {
    codes: readonly ModelHitchErrorCode[];
    maxAttempts: number;
    onFailover: (event: FailoverEvent) => void;
    cooldown?: LaneCooldown;
    onSuccess?: (target: FailoverTarget) => void;
    delayMsBeforeFailover?: (from: FailoverTarget, err: unknown, attempt: number) => number | undefined;
    onExhausted?: (info: ExhaustionInfo) => void;
  } {
    return {
      codes: this.policy
        ? (this.policy.retryableCodes ?? DEFAULT_RETRYABLE_CODES)
        : retryableCodesFor(opts),
      maxAttempts: this.policy ? targets.length : maxAttemptsFor(opts, targets.length - 1),
      onFailover: (event) => this.emitFailover(event),
      cooldown: this.cooldown,
      onSuccess: (target) => this.cooldown?.success?.(target),
      delayMsBeforeFailover: this.policy
        ? (from, err, attempt) => this.delayBeforeFailover(from, err, attempt)
        : undefined,
      onExhausted: this.onExhausted,
    };
  }

  /** Fallback-lane credentials: keystore only (per-call keys stay primary). */
  private async laneCredentials(providerId: string): Promise<ProviderCredentials> {
    if (this.keystore) {
      const apiKey = await this.keystore.get(providerId);
      if (apiKey) return { apiKey };
    }
    return {};
  }

  private emitFailover(event: FailoverEvent): void {
    this.onFailover?.(event);
  }

  /** Complete (non-streaming) chat call — with optional auto-mode failover. */
  async chat(input: ChatInput, credentialsOverride?: ProviderCredentials): Promise<ChatResult> {
    const provider = this.resolveProvider(input);
    const primaryModel = this.resolveModel(provider, input);
    const params = this.buildParams(input, provider);
    const credentials = credentialsOverride ?? (await this.resolveCredentials(provider, input));
    const requirements = inferRequirements(params);
    const targets = this.capableTargets(this.failoverTargets(provider.id, primaryModel), requirements);
    if (targets.length <= 1 && targets[0]?.providerId === provider.id && targets[0]?.model === primaryModel) {
      return provider.chat(params, credentials);
    }

    const opts = this.autoMode;
    const { value } = await withFailover(
      targets,
      async (target) => {
        if (target.providerId === provider.id && target.model === primaryModel) {
          return provider.chat(params, credentials);
        }
        const laneProvider = this.provider(target.providerId);
        const laneCreds = await this.laneCredentials(target.providerId);
        return laneProvider.chat({ ...params, model: target.model }, laneCreds);
      },
      this.failoverContext(opts, targets),
    );
    return value;
  }

  /**
   * Streaming chat call — normalized `StreamChunk` events. With auto-mode,
   * failover happens transparently before the first chunk is emitted (a 429
   * on lane 1 restarts on lane 2); lanes that die mid-stream propagate.
   */
  async stream(input: ChatInput, credentialsOverride?: ProviderCredentials): Promise<AsyncIterable<StreamChunk>> {
    const provider = this.resolveProvider(input);
    const primaryModel = this.resolveModel(provider, input);
    const params = this.buildParams(input, provider);
    const credentials = credentialsOverride ?? (await this.resolveCredentials(provider, input));
    const requirements = inferRequirements(params, { streaming: true });
    const targets = this.capableTargets(this.failoverTargets(provider.id, primaryModel), requirements);
    if (targets.length <= 1 && targets[0]?.providerId === provider.id && targets[0]?.model === primaryModel) {
      return provider.stream(params, credentials);
    }

    const opts = this.autoMode;
    // Resolve fallback-lane credentials eagerly (they are static per lane and
    // the failover generator needs a synchronous attempt callback). Filter by
    // identity rather than index — capability filtering may have dropped the
    // primary lane itself, so it isn't necessarily at index 0 anymore.
    const laneCreds = new Map<string, ProviderCredentials>();
    for (const target of targets) {
      if (target.providerId === provider.id && target.model === primaryModel) continue;
      if (!laneCreds.has(target.providerId)) {
        laneCreds.set(target.providerId, await this.laneCredentials(target.providerId));
      }
    }
    return withFailoverStream(
      targets,
      (target) => {
        if (target.providerId === provider.id && target.model === primaryModel) {
          return provider.stream(params, credentials);
        }
        return this.provider(target.providerId).stream(
          { ...params, model: target.model },
          laneCreds.get(target.providerId) ?? {},
        );
      },
      this.failoverContext(opts, targets),
    );
  }

  /** Convenience: consume a stream and return the full aggregated result. */
  async streamToResult(input: ChatInput, credentialsOverride?: ProviderCredentials): Promise<ChatResult> {
    const iterable = await this.stream(input, credentialsOverride);
    return aggregateStream(iterable);
  }

  /** Capabilities of a provider (streaming? tool calling? vision?). */
  capabilities(providerId: string): Capabilities {
    return this.provider(providerId).capabilities;
  }

  /** Fetch the models a provider offers, if it supports discovery. */
  async listModels(
    providerId: string,
    credentialsOverride?: ProviderCredentials,
  ): Promise<ModelInfo[]> {
    const provider = this.provider(providerId);
    if (!provider.listModels) {
      throw new ModelHitchError(
        'provider-error',
        `Provider "${providerId}" does not support model listing.`,
        { providerId },
      );
    }
    const credentials =
      credentialsOverride ??
      (this.keystore ? { apiKey: (await this.keystore.get(providerId)) ?? undefined } : {});
    return provider.listModels(credentials);
  }
}
