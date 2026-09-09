import { ModelHitchError, type ModelHitchErrorCode } from './errors.js';

/**
 * auto-mode — transparent failover when a provider lane errors.
 *
 * Detection matches both the normalized `code` and the raw HTTP status:
 * - `rate-limited` (HTTP 429 — provider/gateway rate limits)
 * - `provider-error` (5xx gateway blips)
 * - `network-error` (transient connectivity failures)
 * - **any** error carrying `status === 429`, regardless of code — the
 *   Anthropic streaming adapter currently surfaces 429s as `bad-request`
 *   with the status preserved.
 *
 * Aborts and user cancellations are not `ModelHitchError`s, so they are never
 * retried. Failover only happens *before* content is emitted — a lane that
 * dies mid-stream propagates its error instead of duplicating output.
 */

export interface FailoverTarget {
  providerId: string;
  model: string;
}

export interface FailoverErrorInfo {
  code: ModelHitchErrorCode | 'unknown';
  message: string;
  status?: number;
  /** Milliseconds the provider asked us to wait (Retry-After), when known. */
  retryAfterMs?: number;
}

export interface FailoverEvent {
  /** ISO timestamp. */
  at: string;
  /** The lane that failed. */
  from: FailoverTarget;
  /** The lane that took over. */
  to: FailoverTarget;
  error: FailoverErrorInfo;
  /** 0-based index of the lane that took over (1 = first fallback). */
  attempt: number;
}

export interface AutoModeOptions {
  /** Ordered fallback provider/model lanes, tried after the primary fails. */
  lanes?: FailoverTarget[];
  /** Same-provider fallback models, tried before `lanes`. */
  models?: string[];
  /** Error codes that trigger failover (HTTP 429 always triggers regardless). Default: rate-limited, provider-error, network-error. */
  retryableCodes?: ModelHitchErrorCode[];
  /** Total attempts including the primary. Default: 1 + fallback lane count. */
  maxAttempts?: number;
  /** Called each time a lane takes over. */
  onFailover?: (event: FailoverEvent) => void;
}

export const DEFAULT_RETRYABLE_CODES: ModelHitchErrorCode[] = [
  'rate-limited',
  'provider-error',
  'network-error',
];

/**
 * The default fallback lineup for auto-mode. Prefers alternate models on
 * Vercel AI Gateway (same credential), then a direct OpenAI lane when a
 * dedicated `OPENAI_API_KEY` is available.
 *
 * Lanes without configured credentials (missing/invalid key) are skipped
 * automatically; lanes duplicate of the primary are deduped.
 */
export const DEFAULT_FAILOVER_LANES: FailoverTarget[] = [
  { providerId: 'vercel-ai-gateway', model: 'anthropic/claude-sonnet-4.6' },
  { providerId: 'vercel-ai-gateway', model: 'google/gemini-3-flash' },
  { providerId: 'openai', model: 'gpt-5.4' },
];

/** True when the error should trigger a failover to the next lane. */
export function isRetryableError(
  err: unknown,
  codes: readonly ModelHitchErrorCode[] = DEFAULT_RETRYABLE_CODES,
): boolean {
  if (!(err instanceof ModelHitchError)) return false;
  if (err.status === 429) return true;
  return codes.includes(err.code);
}

/** True when a lane simply has no working key — skip it silently. */
export function isCredentialError(err: unknown): boolean {
  return (
    err instanceof ModelHitchError &&
    (err.code === 'missing-api-key' || err.code === 'invalid-api-key')
  );
}

export function errorInfo(err: unknown): FailoverErrorInfo {
  if (err instanceof ModelHitchError)
    return {
      code: err.code,
      message: err.message,
      status: err.status,
      retryAfterMs: err.retryAfterMs,
    };
  if (err instanceof Error) return { code: 'unknown', message: err.message };
  return { code: 'unknown', message: String(err) };
}

/** Build the ordered, deduped fallback lane list for a primary provider/model. */
export function resolveLanes(
  primary: FailoverTarget,
  opts: AutoModeOptions | boolean | undefined,
): FailoverTarget[] {
  if (!opts) return [];
  const options = opts === true ? {} : opts;
  const lanes: FailoverTarget[] = [];
  const seen = new Set<string>([`${primary.providerId}/${primary.model}`]);
  const push = (t: FailoverTarget) => {
    const key = `${t.providerId}/${t.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    lanes.push(t);
  };
  if (options.models) for (const model of options.models) push({ providerId: primary.providerId, model });
  if (options.lanes) for (const lane of options.lanes) push(lane);
  // Explicit lanes/models win; defaults apply only when neither is configured.
  if (!options.models && !options.lanes) for (const lane of DEFAULT_FAILOVER_LANES) push(lane);
  return lanes;
}

export function retryableCodesFor(opts: AutoModeOptions | boolean | undefined): ModelHitchErrorCode[] {
  if (!opts) return [];
  return opts === true ? [...DEFAULT_RETRYABLE_CODES] : [...(opts.retryableCodes ?? DEFAULT_RETRYABLE_CODES)];
}

/** Total attempts (primary + lanes) honoring an explicit cap. */
export function maxAttemptsFor(opts: AutoModeOptions | boolean | undefined, laneCount: number): number {
  if (!opts) return 1;
  return opts === true ? laneCount + 1 : (opts.maxAttempts ?? laneCount + 1);
}

/**
 * Per-lane cooling, consumed by the failover loops. `MemoryLaneCooldown`
 * cools on failure (Retry-After aware); `CircuitBreaker` (Milestone 3)
 * adds consecutive-failure thresholds, escalating trip windows, and
 * half-open probing. When absent, lanes are never skipped and failures
 * never cool anything — this is the pre-Milestone-1 behavior.
 */
export interface LaneCooldown {
  /** Remaining ms the lane should be skipped; 0 = usable (half-open). */
  cooldownMs(lane: FailoverTarget): number;
  /**
   * Record a failure and cool the lane. Accepts either a raw Retry-After
   * duration (ms) or the normalized failure info the failover loop reports.
   */
  cool(lane: FailoverTarget, retryAfterMsOrError?: number | FailoverErrorInfo): void;
  /**
   * Optional: a lane succeeded. Implementations reset health state. The
   * failover loop calls this through `FailoverContext.onSuccess`.
   */
  success?(lane: FailoverTarget): void;
}

/** One lane's failure during a walk that bottomed out. */
export interface LaneAttempt {
  target: FailoverTarget;
  error: FailoverErrorInfo;
}

/** Everything we know when every lane has failed (or was skipped). */
export interface ExhaustionInfo {
  /** The full ordered target list for the walk. */
  targets: FailoverTarget[];
  /** Failures that actually occurred, in walk order. */
  attempts: LaneAttempt[];
  /** The first error — the lane the user actually configured. */
  firstError: unknown;
}

/**
 * The terminal error of a bottomed-out walk (Milestone 4). Extends
 * `ModelHitchError` and PRESERVES the first error's code, message, status,
 * and Retry-After so existing "rethrow the first error" contracts hold —
 * callers detect the bottom-out via `isExhaustedError` / `instanceof` and
 * read `info` for per-lane diagnostics.
 */
export class ExhaustedError extends ModelHitchError {
  readonly info: ExhaustionInfo;
  /** Ordered lane list with the failure each lane produced (attempts may be empty). */
  readonly lanes: LaneAttempt[];

  constructor(
    firstError: unknown,
    info: ExhaustionInfo,
    fallbackMessage = 'All failover lanes failed.',
  ) {
    const first = firstError instanceof ModelHitchError ? firstError : undefined;
    // Preserve the first error's code/status/Retry-After (the lane the user
    // actually configured). Enrich the message when multiple lanes were tried
    // so clients can see that rotation ran — not that a single provider alone
    // failed in isolation.
    const baseMessage =
      first?.message ??
      (firstError instanceof Error ? firstError.message : fallbackMessage);
    const message = enrichExhaustionMessage(baseMessage, info, fallbackMessage);
    super(first?.code ?? 'provider-error', message, {
      status: first?.status,
      providerId: first?.providerId,
      retryAfterMs: first?.retryAfterMs,
      cause: firstError,
    });
    this.name = 'ExhaustedError';
    this.info = info;
    this.lanes = info.attempts;
  }
}

/** Narrow a caught error to an exhausted walk (`ExhaustedError`). */
export function isExhaustedError(err: unknown): err is ExhaustedError {
  return err instanceof ExhaustedError;
}

/** Append a short rotation summary when more than one lane was attempted. */
function enrichExhaustionMessage(
  baseMessage: string,
  info: ExhaustionInfo,
  fallbackMessage: string,
): string {
  if (info.attempts.length <= 1) return baseMessage || fallbackMessage;
  const trail = info.attempts
    .map((a) => `${a.target.providerId}/${a.target.model} (${a.error.code})`)
    .join(' → ');
  return `${baseMessage} [rotated ${info.attempts.length} lanes: ${trail}]`;
}

export interface FailoverContext {
  codes?: readonly ModelHitchErrorCode[];
  maxAttempts?: number;
  onFailover?: (event: FailoverEvent) => void;
  /**
   * When provided, cooled lanes are skipped without attempting, and a
   * retryable failure cools the failed lane (Retry-After aware) so future
   * requests don't re-walk it. Default: none — instant failover, no memory.
   */
  cooldown?: LaneCooldown;
  /** Called when a lane succeeds — resets circuit-breaker state (M3). */
  onSuccess?: (target: FailoverTarget) => void;
  /**
   * Opt-in wait before switching lanes. Returns ms to wait (or `undefined`
   * for instant). Honor Retry-After here — never wait *below* what the
   * provider asked for. Default: undefined — instant failover.
   */
  delayMsBeforeFailover?: (from: FailoverTarget, err: unknown, attempt: number) => number | undefined;
  /** Called when the walk bottomed out — the "limited on all endpoints" signal. */
  onExhausted?: (info: ExhaustionInfo) => void;
}

/** Small await helper kept inline so tests can pass 0/undefined delays. */
function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Non-stream: try each target until one resolves. If every lane fails without
 * producing a result, the FIRST error is rethrown — that's the lane the user
 * actually configured, and it's the actionable one (e.g. the original 429).
 *
 * Cooldown behavior (opt-in via `ctx.cooldown`): lanes on cooldown are
 * skipped without attempting, and a retryable failure cools the failed lane
 * (Retry-After aware). Combined with `delayMsBeforeFailover`, the default
 * remains instant failover — this library never sits and stares at a
 * rate-limit response unless the caller opted in.
 */
export async function withFailover<T, L extends FailoverTarget>(
  targets: L[],
  attempt: (target: L) => Promise<T>,
  ctx: FailoverContext = {},
): Promise<{ value: T; target: L }> {
  const codes = ctx.codes ?? DEFAULT_RETRYABLE_CODES;
  const maxAttempts = ctx.maxAttempts ?? targets.length;
  const attempts: LaneAttempt[] = [];
  let firstError: unknown;
  let i = 0;

  while (i < targets.length && i < maxAttempts) {
    const target = targets[i]!;
    if (ctx.cooldown && ctx.cooldown.cooldownMs(target) > 0) {
      i++; // cooled lane — skip without attempting
      continue;
    }
    try {
      const value = await attempt(target);
      ctx.onSuccess?.(target);
      return { value, target };
    } catch (err) {
      attempts.push({ target, error: errorInfo(err) });
      // Always remember the first real failure — including credential misses —
      // so an exhausted walk never surfaces the empty "All failover lanes
      // failed." fallback when later lanes were only skipped on cooldown.
      firstError ??= err;
      const last = i >= targets.length - 1 || i >= maxAttempts - 1;
      if (last) {
        // Also honor cooling for a final retryable failure (e.g. 429 with
        // Retry-After) so the NEXT request doesn't immediately re-walk a lane
        // its provider told us to leave alone.
        if (isRetryableError(err, codes)) {
          ctx.cooldown?.cool(target, errorInfo(err));
        }
        break;
      }
      if (isCredentialError(err)) {
        i++;
        continue; // no key for this lane — silently try the next
      }
      if (!isRetryableError(err, codes)) throw err;
      ctx.cooldown?.cool(target, errorInfo(err));
      const waitMs = ctx.delayMsBeforeFailover?.(target, err, i + 1);
      await sleep(waitMs ?? 0);
      ctx.onFailover?.({
        at: new Date().toISOString(),
        from: target,
        to: targets[i + 1]!,
        error: errorInfo(err),
        attempt: i + 1,
      });
      i++;
    }
  }

  const exhaustion: ExhaustionInfo = { targets, attempts, firstError };
  ctx.onExhausted?.(exhaustion);
  throw new ExhaustedError(
    firstError,
    exhaustion,
    attempts.length === 0 ? 'All failover lanes are on cooldown; no lane was attempted.' : undefined,
  );
}

/**
 * Streaming: fail over only before any content is emitted. If a lane errors
 * after the caller already received chunks, the error propagates — retrying
 * would duplicate output. Clean completions return immediately.
 */
export function withFailoverStream<T, L extends FailoverTarget>(
  targets: L[],
  attempt: (target: L) => AsyncIterable<T>,
  ctx: FailoverContext = {},
): AsyncIterable<T> {
  const codes = ctx.codes ?? DEFAULT_RETRYABLE_CODES;
  const maxAttempts = ctx.maxAttempts ?? targets.length;
  return (async function* () {
    const attempts: LaneAttempt[] = [];
    let firstError: unknown;
    let i = 0;
    while (i < targets.length && i < maxAttempts) {
      const target = targets[i]!;
      if (ctx.cooldown && ctx.cooldown.cooldownMs(target) > 0) {
        i++; // cooled lane — skip without attempting
        continue;
      }
      let yielded = false;
      try {
        let completed = false;
        for await (const value of attempt(target)) {
          yielded = true;
          yield value;
        }
        completed = true;
        if (completed) ctx.onSuccess?.(target);
        return; // clean completion
      } catch (err) {
        attempts.push({ target, error: errorInfo(err) });
        // Always remember the first real failure — including credential misses —
        // so an exhausted walk never loses the actionable cause when later
        // lanes are only skipped on cooldown.
        firstError ??= err;
        const last = i >= targets.length - 1 || i >= maxAttempts - 1;
        if (last) {
          if (yielded) {
            // Content already sent from the final lane — never duplicate;
            // surface THIS lane's error, and cool it so the next request
            // doesn't immediately re-walk it.
            if (isRetryableError(err, codes)) {
              ctx.cooldown?.cool(target, errorInfo(err));
            }
            throw err;
          }
          if (isRetryableError(err, codes)) {
            ctx.cooldown?.cool(target, errorInfo(err));
          }
          break;
        }
        if (isCredentialError(err)) {
          i++;
          continue; // no key for this lane — silently try the next
        }
        if (!isRetryableError(err, codes)) throw err;
        if (yielded) {
          // Content already sent — never duplicate. Still cool the lane so
          // the NEXT request doesn't immediately re-walk a dying endpoint.
          ctx.cooldown?.cool(target, errorInfo(err));
          throw err;
        }
        ctx.cooldown?.cool(target, errorInfo(err));
        const waitMs = ctx.delayMsBeforeFailover?.(target, err, i + 1);
        await sleep(waitMs ?? 0);
        ctx.onFailover?.({
          at: new Date().toISOString(),
          from: target,
          to: targets[i + 1]!,
          error: errorInfo(err),
          attempt: i + 1,
        });
        i++;
      }
    }
    ctx.onExhausted?.({ targets, attempts, firstError });
    const exhaustion: ExhaustionInfo = { targets, attempts, firstError };
    throw new ExhaustedError(
      firstError,
      exhaustion,
      attempts.length === 0 ? 'All failover lanes are on cooldown; no lane was attempted.' : undefined,
    );
  })();
}
