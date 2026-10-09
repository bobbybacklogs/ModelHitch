import type { ModelHitchErrorCode } from './errors.js';
import { ModelHitchError } from './errors.js';
import type { FailoverTarget } from './failover.js';
import type { Provider } from '../providers/types.js';

/**
 * Milestone 1 — policy-driven failover lanes.
 *
 * The lane is the meaningful trust object: `{ providerId }` trusts "any lane
 * served by this provider's default model", while `{ providerId, models }`
 * trusts only the explicitly listed provider/model lanes. Lanes produced by
 * `trusted` are tried first; `fallback` lanes are tried only after every
 * trusted lane has failed.
 *
 * Nothing here knows about a specific catalog. `ProviderSource` is the
 * socket: Milestone 1 ships `createRegistrySource` (ModelHitch's built-in
 * providers); Milestone 2 ships a catalog-backed source powered by mdev-sdk
 * against models.dev. Policy resolution and validation are identical for
 * both.
 *
 * Milestone 5 (config UX) serializes/loads this same `Policy` shape — it is
 * plain data and JSON-safe by construction.
 */

/** A trusted/fallback entry. `models` omitted/empty = the provider's default model. */
export interface TrustListEntry {
  providerId: string;
  /** Explicit lane models. Empty (or omitted) = the provider's default model lane. */
  models?: string[];
  /**
   * Stop-on-limit: when this lane fails with a retryable error (429, 402, 5xx,
   * network), the walk ends there and the error surfaces instead of rotating to
   * the next lane. Used by custom BYOK lanes whose owner opted out of failover
   * ("stop when this one hits its usage limit"). See `FailoverTarget.terminal`.
   */
  terminal?: boolean;
}

/**
 * Opt-in request-level backoff. When absent, failover is instant — the
 * default — this library never sits and waits on a rate-limit response. When
 * present, the router waits before switching lanes: Retry-After raises the
 * wait up to `maxMs`, and `maxMs` is the hard cap (the user's cap wins over
 * a provider's Retry-After — opting into backoff means "wait a little, then
 * move on", never "sit out the full rate-limit window").
 */
export interface BackoffOptions {
  type: 'fixed' | 'exponential';
  /** Base delay in ms (`fixed`: constant; `exponential`: base * 2^(attempt-1)). */
  baseMs: number;
  /** Hard ceiling on a single wait, ms. */
  maxMs?: number;
}

/** The routing policy. Plain data; JSON-safe. */
export interface Policy {
  /** Preferred lanes, in order. Tried first. At least one of trusted/fallback required. */
  trusted: TrustListEntry[];
  /** Fallback lanes, in order. Tried after every trusted lane failed. */
  fallback: TrustListEntry[];
  /**
   * Optional hard cap on distinct providers across the resolved lane set
   * (primary included). A UX/product knob — never a kernel constant.
   * When exceeded, lowest-priority lanes are trimmed from the tail.
   */
  maxProviders?: number;
  /** Opt-in waiting before a lane switch. Absent = instant failover (default). */
  backoff?: BackoffOptions;
  /** Error codes that trigger failover (HTTP 429 always triggers regardless). */
  retryableCodes?: ModelHitchErrorCode[];
}

/**
 * Where lane targets come from. Milestone 1: the built-in registry.
 * Milestone 2: models.dev via mdev-sdk. Exists so policy resolution stays
 * catalog-agnostic.
 */
export interface ProviderSource {
  /** Every provider the source can route to. */
  providers(): Provider[];
  lookup(providerId: string): Provider | undefined;
  /** The provider's default model (falls back to `provider.defaultModel`). */
  defaultModel(providerId: string): string | undefined;
  /**
   * Enumerable model ids when the source can list them; `undefined` when the
   * models for a provider are unknown (validation is lenient in that case).
   */
  modelsFor?(providerId: string): string[] | undefined;
}

export interface PolicyValidation {
  /** Hard problems — callers should refuse to run with any of these. */
  errors: string[];
  /** Soft problems — usable, but the caller may want to warn. */
  warnings: string[];
}

/** Source backed by a plain list of ModelHitch `Provider`s. */
export function createRegistrySource(providers: readonly Provider[]): ProviderSource {
  const byId = new Map(providers.map((p) => [p.id, p] as const));
  return {
    providers: () => [...providers],
    lookup: (providerId) => byId.get(providerId),
    defaultModel: (providerId) => byId.get(providerId)?.defaultModel,
  };
}

export function validatePolicy(policy: Policy, source: ProviderSource): PolicyValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!policy || typeof policy !== 'object') {
    return { errors: ['Policy must be an object with trusted/fallback arrays.'], warnings };
  }
  if (!Array.isArray(policy.trusted) || !Array.isArray(policy.fallback)) {
    return { errors: ['Policy.trusted and Policy.fallback must both be arrays.'], warnings };
  }
  if (policy.trusted.length === 0 && policy.fallback.length === 0) {
    errors.push('Policy must have at least one entry in trusted or fallback.');
  }

  const entries: Array<{ label: string; entry: TrustListEntry }> = [
    ...policy.trusted.map((entry, i) => ({ label: `trusted[${i}]`, entry })),
    ...policy.fallback.map((entry, i) => ({ label: `fallback[${i}]`, entry })),
  ];

  for (const { label, entry } of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.providerId !== 'string' || !entry.providerId) {
      errors.push(`${label}: must have a non-empty providerId.`);
      continue;
    }
    const provider = source.lookup(entry.providerId);
    if (!provider) {
      const known = source
        .providers()
        .map((p) => p.id)
        .sort()
        .join(', ');
      errors.push(`${label}: unknown provider "${entry.providerId}". Available: ${known}`);
      continue;
    }
    if (entry.models !== undefined && !Array.isArray(entry.models)) {
      errors.push(`${label}: "models" must be an array of model ids.`);
      continue;
    }
    if (entry.terminal !== undefined && typeof entry.terminal !== 'boolean') {
      errors.push(`${label}: "terminal" must be a boolean when set.`);
    }
    const models = entry.models ?? [];
    for (const model of models) {
      if (typeof model !== 'string' || !model) {
        errors.push(`${label}: invalid model id ${JSON.stringify(model)}.`);
      }
    }
    if (source.modelsFor) {
      const known = source.modelsFor(entry.providerId);
      if (known && known.length) {
        const missing = models.filter((m) => !known.includes(m));
        if (missing.length) {
          warnings.push(`${label}: models not found for provider "${entry.providerId}": ${missing.join(', ')}`);
        }
      }
    }
  }

  if (policy.maxProviders !== undefined) {
    if (!Number.isInteger(policy.maxProviders) || policy.maxProviders < 1) {
      errors.push('maxProviders must be a positive integer.');
    }
  }

  if (policy.backoff !== undefined) {
    const b = policy.backoff;
    if (!b || typeof b !== 'object') {
      errors.push('backoff must be an object.');
    } else {
      if (b.type !== 'fixed' && b.type !== 'exponential') {
        errors.push('backoff.type must be "fixed" or "exponential".');
      }
      if (typeof b.baseMs !== 'number' || !Number.isFinite(b.baseMs) || b.baseMs < 0) {
        errors.push('backoff.baseMs must be a non-negative number.');
      }
      if (b.maxMs !== undefined) {
        if (typeof b.maxMs !== 'number' || !Number.isFinite(b.maxMs) || b.maxMs < 0) {
          errors.push('backoff.maxMs must be a non-negative number.');
        } else if (typeof b.baseMs === 'number' && b.maxMs < b.baseMs) {
          errors.push('backoff.maxMs must be >= backoff.baseMs.');
        }
      }
    }
  }

  if (policy.retryableCodes !== undefined) {
    if (!Array.isArray(policy.retryableCodes)) {
      errors.push('retryableCodes must be an array of error codes.');
    } else {
      const valid: readonly string[] = [
        'missing-api-key',
        'invalid-api-key',
        'rate-limited',
        'model-not-found',
        'provider-not-found',
        'provider-error',
        'network-error',
        'bad-request',
      ];
      for (const code of policy.retryableCodes) {
        if (!valid.includes(code)) errors.push(`retryableCodes contains unknown code "${String(code)}".`);
      }
    }
  }

  return { errors, warnings };
}

/**
 * Opt-in delay before a lane switch (policy.backoff). Returns ms to wait or
 * undefined for instant. Waiting is bounded politeness: Retry-After raises
 * the wait up to `maxMs`, and `maxMs` is the hard cap (the user's cap wins
 * over a provider's Retry-After — opting into backoff means "wait a little,
 * then move on", never "sit out the full rate-limit window").
 *
 * Shared by the client and the bridge server so both compute identical waits.
 */
export function computeBackoffDelay(
  backoff: BackoffOptions | undefined,
  err: unknown,
  attempt: number,
): number | undefined {
  if (!backoff) return undefined;
  const exponent = backoff.type === 'exponential' ? Math.pow(2, Math.max(0, attempt - 1)) : 1;
  let ms = backoff.baseMs * exponent;
  const retryAfterMs = err instanceof ModelHitchError ? err.retryAfterMs : undefined;
  if (retryAfterMs !== undefined && retryAfterMs > ms) ms = retryAfterMs;
  if (backoff.maxMs !== undefined && ms > backoff.maxMs) ms = backoff.maxMs;
  return ms;
}

function laneKey(target: FailoverTarget): string {
  return `${target.providerId}/${target.model}`;
}

/**
 * Resolve a policy into an ordered, deduped target list.
 *
 * Order: the caller's primary lane first (an explicit per-call provider/model
 * always wins, matching ModelHitch's existing contract), then every trusted
 * lane (provider→models expanded inline), then every fallback lane. Duplicates
 * are dropped (trusted wins over fallback). `maxProviders` trims from the
 * tail — the lowest-priority lanes go first, so `trusted` is always preserved
 * over `fallback`.
 */
export function resolvePolicyLanes(
  policy: Policy,
  primary: FailoverTarget,
  source: ProviderSource,
): FailoverTarget[] {
  const targets: FailoverTarget[] = [primary];
  const byKey = new Map<string, FailoverTarget>([[laneKey(primary), primary]]);

  const pushEntry = (entry: TrustListEntry) => {
    const provider = source.lookup(entry.providerId);
    if (!provider) return; // validation already surfaced this; fail safe
    const models =
      entry.models && entry.models.length > 0 ? entry.models : [source.defaultModel(entry.providerId) ?? provider.defaultModel];
    for (const model of models) {
      const target: FailoverTarget = {
        providerId: entry.providerId,
        model,
        ...(entry.terminal ? { terminal: true } : {}),
      };
      const key = laneKey(target);
      const existing = byKey.get(key);
      if (existing) {
        // The lane is already in the plan — usually because it is the caller's
        // primary route. It still learns that it is terminal: `stop` must not
        // depend on where the walk entered the plan.
        if (target.terminal) existing.terminal = true;
        continue;
      }
      byKey.set(key, target);
      targets.push(target);
    }
  };

  for (const entry of policy.trusted) pushEntry(entry);
  for (const entry of policy.fallback) pushEntry(entry);

  if (policy.maxProviders !== undefined && policy.maxProviders > 0) {
    trimToMaxProviders(targets, policy.maxProviders);
  }

  return targets;
}

function trimToMaxProviders(targets: FailoverTarget[], maxProviders: number): void {
  const counts = new Map<string, number>();
  for (const t of targets) counts.set(t.providerId, (counts.get(t.providerId) ?? 0) + 1);
  let distinct = counts.size;
  if (distinct <= maxProviders) return;
  // Walk from the tail; removing a provider's last lane lowers the distinct
  // count, removing one of several lanes keeps it. The primary (index 0) is
  // never trimmed.
  for (let i = targets.length - 1; i > 0 && distinct > maxProviders; i--) {
    const providerId = targets[i]!.providerId;
    const remaining = counts.get(providerId) ?? 0;
    targets.splice(i, 1);
    if (remaining <= 1) {
      counts.delete(providerId);
      distinct--;
    } else {
      counts.set(providerId, remaining - 1);
    }
  }
}