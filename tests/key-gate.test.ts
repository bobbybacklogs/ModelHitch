import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashServiceKey, generateServiceKey } from '../src/core/service-keys-crypto.js';
import type { ServiceKey } from '../src/core/service-keys.js';
import {
  ROLLING_WINDOW_MS,
  ServiceKeyGate,
  admissionDecision,
  retryAfterSeconds,
  stripBearer,
  type ServiceKeyUsageWindow,
} from '../src/core/key-gate.js';

/** A fully-formed key for gate tests (limits added per case). */
function key(overrides: Partial<ServiceKey> = {}): ServiceKey {
  const minted = generateServiceKey();
  return {
    id: overrides.id ?? 'k1',
    plan: overrides.plan ?? 'product',
    createdAt: new Date().toISOString(),
    keyHash: minted.hash,
    keyPrefix: minted.prefix,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ServiceKeyGate.authorize', () => {
  it('with zero usable keys the gate is open (backward-compatible local bridge)', () => {
    const gate = new ServiceKeyGate([]);
    expect(gate.requiresKey).toBe(false);
    expect(gate.authorize(undefined).ok).toBe(true);
    expect(gate.authorize('Bearer garbage').ok).toBe(true);
  });

  it('an all-revoked key set is still an open bridge', () => {
    const gate = new ServiceKeyGate([key({ revoked: true })]);
    expect(gate.requiresKey).toBe(false);
    expect(gate.authorize('Bearer mhk_whatever').ok).toBe(true);
  });

  it('once a key exists, missing/unknown headers are 401 with a Bearer hint', () => {
    const k = key({ dailyRequests: 10 });
    const gate = new ServiceKeyGate([k]);
    expect(gate.requiresKey).toBe(true);

    const missing = gate.authorize(undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.status).toBe(401);
      expect(missing.message).toContain('Authorization: Bearer mhk_…');
    }

    const unknown = gate.authorize(`Bearer ${generateServiceKey().key}`);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.status).toBe(401);
  });

  it('a valid key authorizes with its id and plan', () => {
    const k = key({ id: 'product-pro', plan: 'product' });
    const minted = generateServiceKey();
    const gate = new ServiceKeyGate([{ ...k, keyHash: minted.hash }]);
    const auth = gate.authorize(`Bearer ${minted.key}`);
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.keyId).toBe('product-pro');
      expect(auth.plan).toBe('product');
      expect(auth.key.id).toBe('product-pro');
    }
  });

  it('a revoked key stops working (it is removed from the hash set)', () => {
    const minted = generateServiceKey();
    const gate = new ServiceKeyGate([key({ revoked: true, keyHash: minted.hash })]);
    expect(gate.requiresKey).toBe(false); // nothing usable → stays open
    expect(gate.authorize(`Bearer ${minted.key}`).ok).toBe(true);
  });
});

describe('stripBearer', () => {
  it('unwraps both the Bearer form and a bare credential', () => {
    expect(stripBearer('Bearer mhk_abc')).toBe('mhk_abc');
    expect(stripBearer('mhk_abc')).toBe('mhk_abc');
    expect(stripBearer(undefined)).toBeUndefined();
    expect(stripBearer('')).toBeUndefined();
  });
});

describe('admissionDecision — the honest rolling-24h gates', () => {
  it('admits under a hot limit', () => {
    const k = key({ dailyRequests: 10, dailyTokens: 1000, dailyCostUsd: 1 });
    const usage: ServiceKeyUsageWindow = { requests: 3, totalTokens: 100, costUsd: 0.1, oldestAt: new Date().toISOString() };
    expect(admissionDecision(k, usage)).toEqual({ ok: true });
  });

  it('denies at dailyRequests with Retry-After math + the full story in the message', () => {
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    const k = key({ id: 'free-starter', dailyRequests: 500 });
    const oldest = new Date('2026-10-22T01:00:00Z').toISOString(); // 11h ago
    const decided = admissionDecision(k, { requests: 500, totalTokens: 0, costUsd: 0, oldestAt: oldest });
    expect(decided.ok).toBe(false);
    if (!decided.ok) {
      expect(decided.error.status).toBe(429);
      expect(decided.error.retryAfterSeconds).toBe(13 * 3600);
      expect(decided.error.message).toContain('"free-starter"');
      expect(decided.error.message).toContain('500 requests');
      expect(decided.error.message).toContain('rolling 24 hours');
      expect(decided.error.message).toContain('even failed attempts count');
    }
  });

  it('token gates compare recorded (post-response) usage', () => {
    const k = key({ dailyTokens: 100_000 });
    const over: ServiceKeyUsageWindow = { requests: 2, totalTokens: 100_000, costUsd: 0, oldestAt: new Date().toISOString() };
    const decided = admissionDecision(k, over);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect(decided.error.message).toContain('post-response');
    // under: admitted even though the next request could overshoot — the
    // projection is unknown by design; recorded usage has not exceeded yet.
    expect(admissionDecision(k, { requests: 2, totalTokens: 99_999, costUsd: 0, oldestAt: new Date().toISOString() }).ok).toBe(true);
  });

  it('cost gates compare recorded (post-response) usage', () => {
    const k = key({ dailyCostUsd: 1 });
    expect(admissionDecision(k, { requests: 9, totalTokens: 5, costUsd: 1, oldestAt: new Date().toISOString() }).ok).toBe(false);
    expect(admissionDecision(k, { requests: 9, totalTokens: 5, costUsd: 0.99, oldestAt: new Date().toISOString() }).ok).toBe(true);
  });

  it('an empty window admits (nothing recorded yet)', () => {
    const k = key({ dailyRequests: 1 });
    expect(admissionDecision(k, undefined)).toEqual({ ok: true });
  });
});

describe('retryAfterSeconds — the rolling-window math', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');

  it('counts down to when the oldest event ages out of the window', () => {
    expect(retryAfterSeconds(now - 23 * 3600_000, now)).toBe(3600);
    expect(retryAfterSeconds(now - 1000, now)).toBe(ROLLING_WINDOW_MS / 1000 - 1);
  });

  it('returns 1s for an event that already aged out and ~24h without any', () => {
    expect(retryAfterSeconds(now - ROLLING_WINDOW_MS - 1, now)).toBe(1);
    expect(retryAfterSeconds(undefined, now)).toBe(24 * 3600);
  });
});

describe('ServiceKeyGate reservation ledger (open slots count like events)', () => {
  const recorded = (requests: number, tokens = 0, cost = 0): ServiceKeyUsageWindow => ({
    requests,
    totalTokens: tokens,
    costUsd: cost,
    oldestAt: requests ? new Date().toISOString() : undefined,
  });

  it('reservations close when their usage event lands, so slots do not double-count', () => {
    const fakeUsage = () => ({ ...recorded(0), requests: 0 });
    const gate = new ServiceKeyGate([key()], { usage24h: fakeUsage });
    gate.reserveSlot(key());
    gate.reserveSlot(key());
    expect(gate.compositeUsage('k1').requests).toBe(2); // two in-flight, none reported
    gate.reconcileUsage('k1');
    expect(gate.compositeUsage('k1').requests).toBe(1); // one reported, one still open
  });

  it('a reconcile with no open reservation is a no-op', () => {
    const gate = new ServiceKeyGate([key()]);
    expect(() => gate.reconcileUsage('k1')).not.toThrow();
    expect(gate.compositeUsage('k1').requests).toBe(0);
  });

  it('reservations age out of the rolling window like recorded events', async () => {
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    const gate = new ServiceKeyGate([key()]);
    gate.reserveSlot(key());
    gate.reserveSlot(key());
    vi.setSystemTime(new Date('2026-10-23T05:00:00Z')); // 17h later — still in window
    expect(gate.compositeUsage('k1').requests).toBe(2);
    vi.setSystemTime(new Date('2026-10-23T13:00:00Z')); // past 24h
    expect(gate.compositeUsage('k1').requests).toBe(0);
  });

  it('composite carries the oldest anchor so Retry-After counts reservations', () => {
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
    const gate = new ServiceKeyGate([key()], { usage24h: () => undefined });
    gate.reserveSlot(key());
    gate.reserveSlot(key());
    const composite = gate.compositeUsage('k1');
    expect(composite.requests).toBe(2);
    // oldest reservation is "just now" → the window closes ~24h out
    expect(composite.oldestAt).toBeDefined();
    expect(retryAfterSeconds(Date.parse(composite.oldestAt!))).toBeGreaterThan(23 * 3600);
  });
});
