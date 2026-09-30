/**
 * HTTP header helpers. Kept tiny and dependency-free so every adapter
 * (OpenAI-compatible, Anthropic, Gemini, …) can share them.
 */

/**
 * Opt-out of bridge auto-mode failover. When a client sends
 * `x-hitch-no-fallback: 1` (or `true`/`yes`), the bridge attempts only the
 * requested lane and propagates its error, so the caller owns failover.
 * Absent (or any other value) keeps the default transparent-failover
 * behavior. Safe to send to older bridges — unknown headers are ignored.
 */
export const NO_FALLBACK_HEADER = 'x-hitch-no-fallback';

const NO_FALLBACK_TRUTHY = new Set(['1', 'true', 'yes']);

/** True when the request opts out of bridge auto-mode failover. */
export function extractNoFallback(
  headers: Record<string, string | string[] | undefined> | undefined,
): boolean {
  if (!headers) return false;
  const val = headers[NO_FALLBACK_HEADER];
  const first = Array.isArray(val) ? val[0] : val;
  return !!first && NO_FALLBACK_TRUTHY.has(first.trim().toLowerCase());
}

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * Supports both forms the header allows:
 * - `Retry-After: 45` — seconds until retry
 * - `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` — HTTP-date
 *
 * Returns `undefined` for absent, malformed, or already-expired values.
 * The caller decides how to treat "none" (typically: keep the default
 * behavior — instant failover).
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Delta-seconds (allows fractions per the RFC; round up to whole ms).
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isNaN(seconds) || seconds < 0) return undefined;
    return Math.ceil(seconds * 1000);
  }
  // HTTP-date.
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  const ms = date - Date.now();
  return ms > 0 ? ms : undefined;
}