/** Machine-readable error codes used across all providers. */
export type ModelHitchErrorCode =
  | 'missing-api-key'
  | 'invalid-api-key'
  | 'rate-limited'
  | 'model-not-found'
  | 'provider-not-found'
  | 'provider-error'
  | 'network-error'
  | 'bad-request'
  | 'capability-unavailable';

export interface ModelHitchErrorOptions {
  status?: number;
  providerId?: string;
  /** Milliseconds the provider asked us to wait (Retry-After header). */
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * The single error type ModelHitch throws. Apps can switch on `code` to show
 * user-friendly messages (e.g. "Your API key looks wrong" for invalid-api-key).
 */
export class ModelHitchError extends Error {
  readonly code: ModelHitchErrorCode;
  readonly status?: number;
  readonly providerId?: string;
  readonly retryAfterMs?: number;

  constructor(code: ModelHitchErrorCode, message: string, opts: ModelHitchErrorOptions = {}) {
    super(message, { cause: opts.cause });
    this.name = 'ModelHitchError';
    this.code = code;
    this.status = opts.status;
    this.providerId = opts.providerId;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isModelHitchError(err: unknown): err is ModelHitchError {
  return err instanceof ModelHitchError;
}
