
/**
 * Service keys ("mhk_…") — the commercial face of the bridge.
 *
 * The owner mints service keys and hands them to customers. Two plans:
 * - `free`   — the key routes through FREE lanes only (the same machinery the
 *              `modelhitch/free` model id selects), for one-time / free products.
 * - `product`— the key routes through the normal configured plan (real models).
 *
 * Every key carries honest daily limit gates on a rolling-24h window — the same
 * window the usage dashboard labels "Last 24 hours", so what the owner sees on
 * the dashboard is exactly what a customer's gate counts against.
 *
 * Secret hygiene: the config file only ever stores `keyHash` (sha256 hex of the
 * full key material) plus a display `keyPrefix`. The plaintext is printed once
 * at mint/rotate time and lives nowhere else — a leaked config file cannot leak
 * a key, and rotation mints fresh material without touching limits. Gate state
 * is in-memory only; admission counts come from the usage tracker, which is
 * SQLite-backed in the daemon path.
 *
 */

/** The two plans a service key can serve. */
export type ServiceKeyPlan = 'free' | 'product';

export interface ServiceKey {
  /** Stable slug used in logs, dashboards, and CLI commands: 'free-starter', … */
  id: string;
  /** Optional human label shown in the settings page. */
  name?: string;
  /** `free` routes free lanes only; `product` routes the normal plan. */
  plan: ServiceKeyPlan;
  /** Rolling-24h request ceiling; undefined = unlimited. */
  dailyRequests?: number;
  /** Rolling-24h token ceiling; undefined = unlimited. */
  dailyTokens?: number;
  /** Rolling-24h estimated-USD ceiling; undefined = unlimited. */
  dailyCostUsd?: number;
  /** ISO timestamp of mint. */
  createdAt: string;
  /** ISO timestamp of the last rotation, when rotated. */
  rotatedAt?: string;
  /** Revoked keys stop working immediately (after a config hot reload). */
  revoked?: boolean;
  /** Display hint, e.g. `mhk_abc12…` — never the full material. */
  keyPrefix?: string;
  /** sha256 hex of the full key material. Verification compares these. */
  keyHash?: string;
}

export const SERVICE_KEY_PREFIX = 'mhk_';

/** Display prefix: first 10 chars plus an ellipsis, e.g. `mhk_abc12345…`. */
export function keyPrefixOf(key: string): string {
  return `${key.slice(0, 10)}…`;
}

/** True when the key still authenticates requests (present + not revoked). */
export function usableServiceKey(key: ServiceKey | undefined): boolean {
  return key !== undefined && key.revoked !== true;
}

const LIMIT_FIELDS = ['dailyRequests', 'dailyTokens', 'dailyCostUsd'] as const;

/** The names of the limits a key may carry, in the order messages list them. */
export const SERVICE_KEY_LIMIT_FIELDS: readonly string[] = LIMIT_FIELDS;

/**
 * Validate + normalize a config's `serviceKeys` array.
 *
 * Returns the well-formed entries plus one rejection reason per bad entry, so
 * a settings Apply or CLI write can show exactly which key entries were
 * refused. Bad entries are rejected rather than repaired: a mis-typed limit is
 * a product decision the owner should see, not something the bridge guesses.
 */
export function normalizeServiceKeys(value: unknown): { keys: ServiceKey[]; errors: string[] } {
  const errors: string[] = [];
  if (value === undefined) return { keys: [], errors };
  if (!Array.isArray(value)) return { keys: [], errors: ['serviceKeys must be an array.'] };
  const keys: ServiceKey[] = [];
  value.forEach((entry, index) => {
    const label = `serviceKeys[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label}: must be an object.`);
      return;
    }
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== 'string' || !raw.id.trim()) {
      errors.push(`${label}: must have a non-empty "id".`);
      return;
    }
    if (raw.plan !== 'free' && raw.plan !== 'product') {
      errors.push(`${label} (${raw.id}): plan must be "free" or "product".`);
      return;
    }
    const normalized: ServiceKey = {
      id: raw.id.trim(),
      plan: raw.plan,
      // Mint-time default; an existing entry keeps its own ISO stamp.
      createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    };
    if (typeof raw.name === 'string' && raw.name.trim()) normalized.name = raw.name.trim();
    for (const field of LIMIT_FIELDS) {
      const limit = raw[field];
      if (limit === undefined || limit === null) continue;
      if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
        errors.push(`${label} (${raw.id}): ${field} must be a positive number.`);
        return;
      }
      (normalized as unknown as Record<string, unknown>)[field] = limit;
    }
    if (typeof raw.rotatedAt === 'string' && raw.rotatedAt) normalized.rotatedAt = raw.rotatedAt;
    if (raw.revoked === true) normalized.revoked = true;
    else if (raw.revoked !== undefined && raw.revoked !== false) {
      errors.push(`${label} (${raw.id}): revoked must be a boolean.`);
      return;
    }
    if (typeof raw.keyPrefix === 'string' && raw.keyPrefix) normalized.keyPrefix = raw.keyPrefix;
    if (typeof raw.keyHash === 'string' && raw.keyHash) {
      if (!/^[0-9a-f]{64}$/i.test(raw.keyHash)) {
        // A key without a usable hash can never authenticate — reject loudly.
        errors.push(`${label} (${raw.id}): keyHash must be a sha256 hex digest.`);
        return;
      }
      normalized.keyHash = raw.keyHash.toLowerCase();
    } else if (raw.keyHash !== undefined && raw.keyHash !== null) {
      errors.push(`${label} (${raw.id}): keyHash must be a sha256 hex digest.`);
      return;
    }
    keys.push(normalized);
  });
  return { keys, errors };
}
