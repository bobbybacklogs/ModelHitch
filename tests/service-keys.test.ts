import { describe, expect, it } from 'vitest';
import {
  SERVICE_KEY_PREFIX,
  keyPrefixOf,
  normalizeServiceKeys,
  usableServiceKey,
  type ServiceKey,
} from '../src/core/service-keys.js';
import { generateServiceKey, hashServiceKey, serviceKeyHashesEqual } from '../src/core/service-keys-crypto.js';

describe('generateServiceKey / hashServiceKey', () => {
  it('mints `mhk_` + 32 bytes base64url (~38 chars of entropy)', () => {
    const { key, prefix, hash } = generateServiceKey();
    expect(key.startsWith(SERVICE_KEY_PREFIX)).toBe(true);
    const body = key.slice(SERVICE_KEY_PREFIX.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url, unpadded
    expect(body).not.toContain('=');
    expect(prefix).toBe(keyPrefixOf(key));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes deterministically and keeps the prefix to 10 chars + ellipsis', () => {
    expect(hashServiceKey('mhk_hello')).toBe(hashServiceKey('mhk_hello'));
    expect(generateServiceKey().hash).not.toBe(generateServiceKey().hash);
    expect(keyPrefixOf('0123456789abc')).toBe('0123456789…');
  });

  it('changes the hash when the material changes', () => {
    expect(hashServiceKey('mhk_a')).not.toBe(hashServiceKey('mhk_b'));
  });

  it('compares hashes constant-time-tolerant and length-safe', () => {
    const hash = hashServiceKey('mhk_x');
    expect(serviceKeyHashesEqual(hash, hash)).toBe(true);
    expect(serviceKeyHashesEqual(undefined, hash)).toBe(false);
    expect(serviceKeyHashesEqual('short', hash)).toBe(false);
    expect(serviceKeyHashesEqual(`${hash}X`.slice(0, 63), hash)).toBe(false);
  });
});

describe('usableServiceKey', () => {
  it('revoked keys are not usable; keys without a hash still count (CLI minted display rows)', () => {
    const base: ServiceKey = { id: 'k', plan: 'product', createdAt: new Date().toISOString() };
    expect(usableServiceKey(base)).toBe(true);
    expect(usableServiceKey({ ...base, revoked: true })).toBe(false);
    expect(usableServiceKey(undefined)).toBe(false);
  });
});

describe('normalizeServiceKeys', () => {
  it('passes undefined through as empty, rejects non-arrays', () => {
    expect(normalizeServiceKeys(undefined)).toEqual({ keys: [], errors: [] });
    expect(normalizeServiceKeys({}).errors).toContain('serviceKeys must be an array.');
  });

  it('normalizes a valid entry (limits, hash lowercase, kept timestamps)', () => {
    const { keys, errors } = normalizeServiceKeys([
      {
        id: ' free-starter ',
        plan: 'free',
        name: 'Starter',
        dailyRequests: 500,
        dailyTokens: 200_000,
        dailyCostUsd: 2.5,
        createdAt: '2026-01-01T00:00:00.000Z',
        keyHash: 'A'.repeat(64),
        keyPrefix: 'mhk_abc12…',
      },
    ]);
    expect(errors).toEqual([]);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id: 'free-starter', plan: 'free', dailyRequests: 500, keyHash: 'a'.repeat(64) });
  });

  it('rejects bad plans, missing ids, and bad limits with reasons', () => {
    const { keys, errors } = normalizeServiceKeys([
      { plan: 'product', dailyRequests: 5 }, // no id
      { id: 'k1', plan: 'unlimited' }, // bad plan
      { id: 'k2', plan: 'product', dailyRequests: 0 },
      { id: 'k3', plan: 'free', dailyTokens: -1 },
      { id: 'k4', plan: 'free', dailyCostUsd: Number.NaN },
      { id: 'k5', plan: 'free', dailyRequests: 'many' },
      { id: 'k6', plan: 'free', revoked: 'yes' },
      { id: 'k7', plan: 'free', keyHash: 'not-a-hash' },
      'garbage',
    ]);
    expect(keys).toHaveLength(0);
    expect(errors).toHaveLength(9);
    expect(errors.some((e) => e.includes('non-empty "id"'))).toBe(true);
    expect(errors.some((e) => e.includes('plan must be'))).toBe(true);
    expect(errors.some((e) => e.includes('dailyRequests must be a positive number'))).toBe(true);
    expect(errors.some((e) => e.includes('dailyTokens must be a positive number'))).toBe(true);
    expect(errors.some((e) => e.includes('dailyCostUsd must be a positive number'))).toBe(true);
    expect(errors.some((e) => e.includes('revoked must be a boolean'))).toBe(true);
    expect(errors.some((e) => e.includes('keyHash must be a sha256 hex digest'))).toBe(true);
    expect(errors.some((e) => e.includes('must be an object'))).toBe(true);
  });

  it('survives mixed input: good entries pass alongside bad ones', () => {
    const { keys } = normalizeServiceKeys([
      { id: 'good', plan: 'product' },
      { plan: 'product' }, // bad
    ]);
    expect(keys.map((k) => k.id)).toEqual(['good']);
  });
});
