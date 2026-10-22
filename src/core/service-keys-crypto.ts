import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SERVICE_KEY_PREFIX, keyPrefixOf } from './service-keys.js';

/**
 * The Node-only crypto half of service keys: mint, hash, and a constant-time
 * compare. Split out of `service-keys.ts` so the shape/normalization module
 * stays on the browser-safe import graph (tests/browser-entry.test.ts forbids
 * `node:*` imports there); the CLI and bridge server are the only callers, and
 * verification compares stored hashes rather than re-hashing in a browser.
 */

/**
 * Mint fresh key material.
 *
 * Format: `mhk_` + 32 random bytes as base64url — 43 chars of high entropy on
 * top of the prefix, safe in a Bearer header. The config stores only the
 * sha256 hash and a display prefix, so this is the only moment the full key
 * exists in readable form.
 */
export function generateServiceKey(): { key: string; prefix: string; hash: string } {
  const key = `${SERVICE_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, prefix: keyPrefixOf(key), hash: hashServiceKey(key) };
}

/** sha256 hex of the full key material — what the config file stores. */
export function hashServiceKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex digests. Both digests are fixed-length
 * (sha256 hex = 64 chars), so length-checking is only a guard against garbage —
 * timingSafeEqual itself throws on unequal lengths.
 */
export function serviceKeyHashesEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}
