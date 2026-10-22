import type { ModelHitchErrorCode } from './errors.js';
import { SERVICE_KEY_PREFIX, usableServiceKey, type ServiceKey, type ServiceKeyPlan } from './service-keys.js';
import { hashServiceKey } from './service-keys-crypto.js';

/**
 * The service-key gate: authentication + the honest daily limit gates.
 *
 * Two decisions happen here, in the order a client experiences them:
 *
 * 1. `authorize` — the `Bearer mhk_…` header is hashed and compared against
 *    the configured hashes. When the config has zero usable (non-revoked)
 *    service keys there is NO gate at all: the bridge stays exactly the
 *    backward-compatible local bridge it has always been. From the first
 *    configured key onward, every inference route requires a valid key.
 *
 * 2. `admission` — the rolling-24h gate. Deliberately honest about something
 *    most rate limiters gloss over:
 *    - The request count is reserved at ADMISSION, so even failed attempts
 *      (upstream 5xx, provider 429 the walk cannot escape, a client hanging
 *      up mid-stream) consume a slot. NOTHING can know a request's tokens
 *      before the provider answers, so a request is admitted while its
 *      projected cost is, honestly, unknown; what the gate enforces is that
 *      recorded usage stays under the limit, and the messages say so
 *      ("honest, post-response" is the contract being documented).
 *
 * The window is rolling (anchor = now − 24h), matching the usage dashboard's
 * "Last 24 hours" slice — the owner verifies a customer's claim against the
 * same numbers.
 *
 * How counting works (the reservation ledger):
 * - Token/USD usage: what the usage tracker recorded for this key id. That is
 *   SQLite-backed in the daemon path, so it survives restarts and is exactly
 *   the dashboard's per-key row.
 * - Requests: RECORDED usage events for the key (persisted) PLUS open
 *   in-memory reservations — timestamps pushed at admission, popped one-for-
 *   one when the request's usage event lands (`reconcileReceipt`, called from
 *   the server's usage funnel). A request whose event never lands (upstream
 *   error, aborted stream) keeps its open reservation until it ages out of
 *   the window: the slot was consumed, so it is counted. This is the only
 *   in-memory state the gate owns, and it is deliberately transient —
 *   everything that matters after a restart lives in the tracker.
 */

/** Rolling-24h window length, in ms. */
export const ROLLING_WINDOW_MS = 24 * 3_600_000;

/** How a key's recorded use in the rolling window. Mirrors the dashboard. */
export interface ServiceKeyUsageWindow {
  requests: number;
  totalTokens: number;
  costUsd: number;
  /** ISO timestamp of the oldest event still inside the window, when any. */
  oldestAt?: string;
}

/**
 * Where the gate reads recorded usage from. The server injects a source backed
 * by the `UsageTracker` (SQLite-backed in the daemon path), so counts survive
 * restarts and match the dashboard. Kept as a bound function so the gate stays
 * stateless and unit-testable against a fake snapshot source.
 */
export type ServiceKeyUsageSource = (keyId: string) => ServiceKeyUsageWindow | undefined;

/** The failure half of `authorize`. Plain data, mapped onto each wire's error envelope. */
export interface ServiceKeyDenial {
  status: 401 | 429 | number;
  code: ModelHitchErrorCode;
  message: string;
  /** Seconds until the rolling window frees a slot; set on 429 only. */
  retryAfterSeconds?: number;
}

export type ServiceKeyAuthorization =
  | { ok: true; keyId: string; plan: ServiceKeyPlan; key: ServiceKey }
  | { ok: false; status: number; message: string; code: ModelHitchErrorCode; retryAfterSeconds?: number };

/**
 * Compute the rolling-window admission decision for one key against its
 * recorded 24h usage. Pure: everything the decision needs is in the arguments.
 */
export function admissionDecision(
  key: ServiceKey,
  usage: ServiceKeyUsageWindow | undefined,
): { ok: true } | { ok: false; error: ServiceKeyDenial } {
  const over = overLimit(key, usage);
  if (!over) return { ok: true };
  return {
    ok: false,
    error: {
      status: 429,
      code: 'rate-limited',
      message: admissionMessage(key, usage ?? { requests: 0, totalTokens: 0, costUsd: 0 }),
      retryAfterSeconds: retryAfterSeconds((usage?.oldestAt ? Date.parse(usage.oldestAt) : undefined) ?? new Date().getTime()),
    },
  };
}

/** The first gate the usage records exceed, so messages stay single-issue. */
function overLimit(
  key: ServiceKey,
  usage: ServiceKeyUsageWindow | undefined,
): keyof Pick<ServiceKey, 'dailyRequests' | 'dailyTokens' | 'dailyCostUsd'> | undefined {
  const current = {
    dailyRequests: usage?.requests ?? 0,
    dailyTokens: usage?.totalTokens ?? 0,
    dailyCostUsd: usage?.costUsd ?? 0,
  };
  if (key.dailyRequests !== undefined && current.dailyRequests + 1 > key.dailyRequests) return 'dailyRequests';
  // Token/USD gates compare RECORDED usage (post-response) — see module doc.
  if (key.dailyTokens !== undefined && current.dailyTokens >= key.dailyTokens) return 'dailyTokens';
  if (key.dailyCostUsd !== undefined && current.dailyCostUsd >= key.dailyCostUsd) return 'dailyCostUsd';
  return undefined;
}

/**
 * Seconds until a slot frees: the window anchor is `now - 24h`; if the oldest
 * recorded event for the key is still inside the window, a slot reopens once
 * it ages past `oldest + 24h`. Without a recorded oldest event (nothing yet in
 * the window — e.g. requests admitted but not yet reported), a pragmatic `24h`
 * is the honest upper bound; clamped to at least 1 second.
 */
export function retryAfterSeconds(oldestAtMs: number | undefined, now = Date.now()): number {
  if (oldestAtMs === undefined) return ROLLING_WINDOW_MS / 1000;
  const anchor = now - ROLLING_WINDOW_MS;
  if (oldestAtMs <= anchor) return 1; // already outside the window — free next second
  return Math.max(1, Math.ceil((oldestAtMs + ROLLING_WINDOW_MS - now) / 1000));
}

function admissionMessage(key: ServiceKey, usage: ServiceKeyUsageWindow): string {
  const limits: string[] = [];
  if (key.dailyRequests !== undefined) limits.push(`${key.dailyRequests} requests/day`);
  if (key.dailyTokens !== undefined) limits.push(`${key.dailyTokens} tokens/day`);
  if (key.dailyCostUsd !== undefined) limits.push(`$${key.dailyCostUsd.toFixed(2)}/day`);
  const current: string[] = [];
  if (usage.requests) current.push(`${usage.requests} requests`);
  if (usage.totalTokens) current.push(`${usage.totalTokens} tokens`);
  if (usage.costUsd) current.push(`$${usage.costUsd.toFixed(4)}`);
  return (
    `Daily limit reached for service key "${key.id}" (limit: ${limits.join(', ')}; ` +
    `used in the last 24 hours: ${current.join(', ') || 'none'}). ` +
    `The window is the rolling 24 hours the usage dashboard shows, and even failed attempts ` +
    `count — a slot is reserved when a request is admitted. Token and cost gates are ` +
    `enforced against recorded (post-response) usage.`
  );
}

/** In-memory gate. Usage counts live in the tracker — see the module doc. */
export class ServiceKeyGate {
  private byHash = new Map<string, ServiceKey>();
  private open = true;
  private readonly usage24h?: ServiceKeyUsageSource;
  /**
   * Open admission reservations per key id: ms timestamps of admitted requests
   * whose usage event has not landed yet. Transient ledger, see module doc.
   */
  private reservations = new Map<string, number[]>();

  constructor(keys: readonly ServiceKey[], options: { usage24h?: ServiceKeyUsageSource } = {}) {
    this.usage24h = options.usage24h;
    for (const key of keys) {
      if (!usableServiceKey(key)) continue; // revoked keys never authenticate
      if (typeof key.keyHash !== 'string') continue; // hashes cannot be verified against
      this.byHash.set(key.keyHash.toLowerCase(), key);
    }
    // Zero usable keys = no gate at all (backward-compatible local bridge).
    this.open = this.byHash.size === 0;
  }

  /**
   * Check the `Bearer mhk_…` value (or a bare key — the caller strips the
   * transport header, this takes the credential value). A bridge with no
   * usable keys admits everything, so local usage is unchanged until a key
   * is minted (`requiresKey` reports whether the gate is live at all).
   */
  authorize(credential: string | undefined): ServiceKeyAuthorization {
    const plaintext = stripBearer(credential);
    if (this.open) return { ok: true, keyId: '', plan: 'product', key: undefined as unknown as ServiceKey };
    if (!plaintext) {
      return deny(401, 'invalid-api-key', 'A service key is required. Send it as `Authorization: Bearer mhk_…`.');
    }
    const key = this.byHash.get(hashServiceKey(plaintext));
    if (!key) {
      // Unknown (or revoked-and-removed) key material hashes to nothing we stored.
      return deny(401, 'invalid-api-key', 'Unknown or revoked service key.');
    }
    return { ok: true, keyId: key.id, plan: key.plan, key };
  }

  /** True when at least one usable service key is configured → gate is live. */
  get requiresKey(): boolean {
    return !this.open;
  }

  /**
   * The second gate: compare the key's limits against its recorded rolling-24h
   * usage. `usage` absent = nothing recorded in the window yet. Pure — callers
   * that also track in-flight reservations compose them into `usage` first
   * (see `compositeUsage`).
   */
  checkAdmission(key: ServiceKey, usage?: ServiceKeyUsageWindow): { ok: true } | { ok: false; error: ServiceKeyDenial } {
    return admissionDecision(key, usage);
  }

  /** Recorded rolling-24h usage for a key via the injected source. */
  recordedUsage(keyId: string): ServiceKeyUsageWindow | undefined {
    return this.usage24h?.(keyId);
  }

  /**
   * Reserve a request slot. ONE inbound request admits ONE slot, regardless
   * of how the walk rotates internally — this is called exactly once, from
   * `dispatch`, after the key authorizes but only after the gate has decided
   * it can be admitted (decide first, then reserve: reserving the slot first
   * would make the very first request over-limit).
   */
  reserveSlot(key: ServiceKey): void {
    this.pruneReservations(Date.now(), key.id);
    const list = this.reservations.get(key.id) ?? [];
    list.push(Date.now());
    this.reservations.set(key.id, list);
  }

  /**
   * A usage event landed for the key — either a full one or a zero-usage
   * receipt for a failed attempt. Pop the oldest open reservation so it
   * stops being double-counted next to the event that replaced it.
   */
  reconcileUsage(keyId: string): void {
    const list = this.reservations.get(keyId);
    if (!list || list.length === 0) return;
    list.shift();
    if (list.length === 0) this.reservations.delete(keyId);
  }

  /**
   * The key's usage as `checkAdmission` should see it: recorded events plus
   * the still-open reservations, with the oldest anchor across both (the
   * Retry-After math must consider a reservation too — a slot for it reopens
   * on the same schedule).
   */
  compositeUsage(keyId: string, now = Date.now()): ServiceKeyUsageWindow {
    this.pruneReservations(now, keyId);
    const open = this.reservations.get(keyId) ?? [];
    const base = this.usage24h?.(keyId);
    const oldestOpen = open.length ? Math.min(...open) : undefined;
    const baseOldest = base?.oldestAt !== undefined ? Date.parse(base.oldestAt) : undefined;
    let oldestAt: string | undefined;
    if (baseOldest !== undefined || oldestOpen !== undefined) {
      oldestAt = new Date(Math.min(baseOldest ?? Infinity, oldestOpen ?? Infinity)).toISOString();
    }
    if (!base) {
      return {
        requests: open.length,
        totalTokens: 0,
        costUsd: 0,
        ...(oldestAt !== undefined ? { oldestAt } : {}),
      };
    }
    return {
      requests: base.requests + open.length,
      totalTokens: base.totalTokens,
      costUsd: base.costUsd,
      ...(oldestAt !== undefined ? { oldestAt } : {}),
    };
  }

  /** Drop reservations older than the window — aged-out slots reopen. */
  private pruneReservations(now: number, keyId?: string): void {
    const cutoff = now - ROLLING_WINDOW_MS;
    const keys = keyId ? [keyId] : [...this.reservations.keys()];
    for (const id of keys) {
      const list = this.reservations.get(id);
      if (!list) continue;
      const fresh = list.filter((ts) => ts > cutoff);
      if (fresh.length === 0) this.reservations.delete(id);
      else this.reservations.set(id, fresh);
    }
  }
}

function deny(status: 401, code: ModelHitchErrorCode, message: string): ServiceKeyAuthorization {
  return { ok: false, status, message, code };
}

/** Accept `Bearer mhk_…` or the raw key; reject empty/garbage by returning falsy. */
export function stripBearer(headerValue: string | undefined): string | undefined {
  if (typeof headerValue !== 'string') return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('Bearer ') || trimmed.startsWith('bearer ')
    ? trimmed.slice(trimmed.indexOf(' ') + 1).trim()
    : trimmed;
}

/** True when a credential value is shaped like minted service-key material. */
export function looksLikeServiceKey(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().startsWith(SERVICE_KEY_PREFIX);
}
