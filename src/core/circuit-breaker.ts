import type { FailoverErrorInfo, FailoverTarget, LaneCooldown } from './failover.js';

/**
 * Milestone 3 — per-lane circuit breaker.
 *
 * Implements the same `LaneCooldown` contract as `MemoryLaneCooldown` with
 * real health semantics:
 *
 * - 429 / rate-limited failures trip the lane immediately, honoring the
 *   provider's Retry-After (or a short grace window) — a 429 is authoritative.
 * - Other retryable failures (5xx, network) count toward a threshold; once the
 *   lane accumulates `failureThreshold` consecutive failures it trips for an
 *   escalating window (base * 2^(trips), capped at maxTripMs).
 * - While tripped the lane is skipped without attempting (kernel behavior).
 *   Once the trip window passes `cooldownMs` returns 0 and the lane is
 *   probed (half-open): success closes it, another failure re-trips it with
 *   escalation.
 * - A successful call resets the lane (`success`), which the failover loop
 *   invokes through `onSuccess`.
 *
 * State is keyed by lane (providerId + model) — the lane is the meaningful
 * trust object — and exposed via `snapshot()`/`snapshotFor()` for
 * observability (status dashboards, the settings UI).
 */

export interface CircuitBreakerOptions {
  /** Clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Consecutive retryable failures that trip a lane (5xx/network). Default 3. */
  failureThreshold?: number;
  /** Escalating trip base (ms). Actual = base * 2^(trips-1), capped. Default 15_000. */
  baseTripMs?: number;
  /** Ceiling on a single trip window (ms). Default 120_000. */
  maxTripMs?: number;
  /** Cool applied for a single non-tripping failure / 429 without Retry-After. Default 5_000. */
  graceMs?: number;
  /** A 429 trips the lane immediately (even below the threshold). Default true. */
  rateLimitTripsImmediately?: boolean;
}

export type LaneHealthState = 'closed' | 'open' | 'half-open';

/** Observable health for one lane (feeds the settings/dashboard UI). */
export interface LaneHealth {
  providerId: string;
  model: string;
  state: LaneHealthState;
  consecutiveFailures: number;
  /** How many times the lane has been tripped (resets on success). */
  trips: number;
  /** Absolute ms timestamp the current trip expires (0 when not tripped). */
  trippedUntilMs: number;
  /** Remaining ms until the lane may be probed again (0 when usable). */
  remainingMs: number;
}

interface LaneState {
  consecutiveFailures: number;
  trips: number;
  trippedUntil: number;
}

function key(lane: FailoverTarget): string {
  return `${lane.providerId}/${lane.model}`;
}

function toLane(key: string): FailoverTarget {
  const slash = key.indexOf('/');
  return { providerId: key.slice(0, slash), model: key.slice(slash + 1) };
}

export class CircuitBreaker implements LaneCooldown {
  private readonly now: () => number;
  private readonly failureThreshold: number;
  private readonly baseTripMs: number;
  private readonly maxTripMs: number;
  private readonly graceMs: number;
  private readonly rateLimitTripsImmediately: boolean;
  private readonly lanes = new Map<string, LaneState>();
  /** Last reported failure per lane — read by terminal (stop-on-limit) lanes. */
  private readonly failures = new Map<string, FailoverErrorInfo>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.failureThreshold = options.failureThreshold ?? 3;
    this.baseTripMs = options.baseTripMs ?? 15_000;
    this.maxTripMs = options.maxTripMs ?? 120_000;
    this.graceMs = options.graceMs ?? 5_000;
    this.rateLimitTripsImmediately = options.rateLimitTripsImmediately ?? true;
  }

  cooldownMs(lane: FailoverTarget): number {
    const st = this.lanes.get(key(lane));
    if (!st) return 0;
    const remaining = st.trippedUntil - this.now();
    return Math.max(0, remaining);
  }

  cool(lane: FailoverTarget, retryAfterMsOrError?: number | FailoverErrorInfo): void {
    const info: FailoverErrorInfo =
      typeof retryAfterMsOrError === 'number'
        ? { code: 'unknown', message: '', retryAfterMs: retryAfterMsOrError }
        : (retryAfterMsOrError ?? { code: 'unknown', message: '' });
    const k = key(lane);
    const st = this.lanes.get(k) ?? { consecutiveFailures: 0, trips: 0, trippedUntil: 0 };
    st.consecutiveFailures += 1;
    const now = this.now();
    const isRateLimit = info.status === 429 || info.code === 'rate-limited';

    if (isRateLimit && this.rateLimitTripsImmediately) {
      // A rate limiter is authoritative: honor Retry-After (capped), or a
      // short grace window when the provider didn't tell us how long.
      const ra = info.retryAfterMs;
      const duration = ra !== undefined && ra > 0 ? ra : this.graceMs;
      st.trippedUntil = now + Math.min(duration, this.maxTripMs);
    } else if (st.consecutiveFailures >= this.failureThreshold) {
      st.trips += 1;
      // Once tripped, the provider's Retry-After is authoritative if it told
      // us how long — regardless of the trip policy — otherwise escalate.
      const ra = info.retryAfterMs;
      const duration =
        ra !== undefined && ra > 0
          ? Math.min(ra, this.maxTripMs)
          : Math.min(this.baseTripMs * Math.pow(2, st.trips - 1), this.maxTripMs);
      st.trippedUntil = now + duration;
    } else {
      // Below threshold: brief cool so a single blip doesn't get re-hammered
      // within one walk, but the lane stays usable soon after.
      st.trippedUntil = now + this.graceMs;
    }
    this.lanes.set(k, st);
    this.failures.set(k, info);
  }

  /** A lane succeeded — close the circuit and reset its health. */
  success(lane: FailoverTarget): void {
    this.lanes.set(key(lane), { consecutiveFailures: 0, trips: 0, trippedUntil: 0 });
    this.failures.delete(key(lane));
  }

  /** The failure that parked a lane, for a terminal lane's error message. */
  lastFailure(lane: FailoverTarget): FailoverErrorInfo | undefined {
    return this.failures.get(key(lane));
  }

  /** Health for every lane with recorded state, sorted by lane key. */
  snapshot(): LaneHealth[] {
    const out: LaneHealth[] = [];
    for (const [k, st] of this.lanes) {
      out.push(this.health(toLane(k), st));
    }
    return out.sort((a, b) => `${a.providerId}/${a.model}`.localeCompare(`${b.providerId}/${b.model}`));
  }

  snapshotFor(lane: FailoverTarget): LaneHealth | undefined {
    const st = this.lanes.get(key(lane));
    return st ? this.health(lane, st) : undefined;
  }

  clear(): void {
    this.lanes.clear();
    this.failures.clear();
  }

  private health(lane: FailoverTarget, st: LaneState): LaneHealth {
    const now = this.now();
    const tripped = st.trippedUntil > now;
    const state: LaneHealthState =
      st.consecutiveFailures === 0 ? 'closed' : tripped ? 'open' : 'half-open';
    return {
      providerId: lane.providerId,
      model: lane.model,
      state,
      consecutiveFailures: st.consecutiveFailures,
      trips: st.trips,
      trippedUntilMs: tripped ? st.trippedUntil : 0,
      remainingMs: Math.max(0, st.trippedUntil - now),
    };
  }
}