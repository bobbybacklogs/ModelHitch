import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FAILOVER_LANES,
  DEFAULT_RETRYABLE_CODES,
  errorInfo,
  isCredentialError,
  isRetryableError,
  maxAttemptsFor,
  resolveLanes,
  retryableCodesFor,
  withFailover,
  withFailoverStream,
  type FailoverTarget,
} from '../src/index.js';
import { ModelHitchError } from '../src/index.js';

const lane = (providerId: string, model: string): FailoverTarget => ({ providerId, model });

describe('isRetryableError', () => {
  it('matches the default retryable codes (429, 5xx, network)', () => {
    expect(isRetryableError(new ModelHitchError('rate-limited', 'slow down', { status: 429 }))).toBe(true);
    expect(isRetryableError(new ModelHitchError('provider-error', 'boom', { status: 502 }))).toBe(true);
    expect(isRetryableError(new ModelHitchError('network-error', 'ECONNRESET'))).toBe(true);
  });

  it('treats any status 429 as retryable regardless of code', () => {
    // The Anthropic streaming adapter maps 429s to bad-request with the
    // status preserved — this must still trigger failover.
    expect(isRetryableError(new ModelHitchError('bad-request', '429 from upstream', { status: 429 }))).toBe(true);
  });

  it('does not retry non-retryable codes', () => {
    expect(isRetryableError(new ModelHitchError('bad-request', 'bad prompt', { status: 400 }))).toBe(false);
    expect(isRetryableError(new ModelHitchError('model-not-found', 'nope', { status: 404 }))).toBe(false);
    expect(isRetryableError(new ModelHitchError('invalid-api-key', 'nope', { status: 401 }))).toBe(false);
  });

  it('never retries plain Errors (aborts, cancellations)', () => {
    expect(isRetryableError(new Error('AbortError'))).toBe(false);
    expect(isRetryableError('not an error')).toBe(false);
  });

  it('honors a custom retryable code list', () => {
    expect(isRetryableError(new ModelHitchError('bad-request', 'x', { status: 400 }), ['bad-request'])).toBe(true);
    expect(isRetryableError(new ModelHitchError('rate-limited', 'x'), [])).toBe(false);
  });
});

describe('isCredentialError', () => {
  it('flags missing/invalid keys but not rate limits', () => {
    expect(isCredentialError(new ModelHitchError('missing-api-key', 'no key'))).toBe(true);
    expect(isCredentialError(new ModelHitchError('invalid-api-key', 'bad key'))).toBe(true);
    expect(isCredentialError(new ModelHitchError('rate-limited', '429'))).toBe(false);
  });
});

describe('errorInfo', () => {
  it('normalizes ModelHitchError, Error, and unknowns', () => {
    expect(errorInfo(new ModelHitchError('rate-limited', 'slow down', { status: 429 }))).toEqual({
      code: 'rate-limited',
      message: 'slow down',
      status: 429,
    });
    expect(errorInfo(new Error('boom'))).toEqual({ code: 'unknown', message: 'boom' });
    expect(errorInfo(42)).toEqual({ code: 'unknown', message: '42' });
  });
});

describe('resolveLanes', () => {
  const primary = lane('vercel-ai-gateway', 'openai/gpt-5.4');

  it('returns [] when autoMode is off', () => {
    expect(resolveLanes(primary, undefined)).toEqual([]);
    expect(resolveLanes(primary, false)).toEqual([]);
  });

  it('uses the default lineup when autoMode is true', () => {
    // Use a primary that is not part of the default lanes, so dedup leaves
    // the full default lineup intact.
    const primary = lane('vercel-ai-gateway', 'custom-primary');
    const lanes = resolveLanes(primary, true);
    expect(lanes).toEqual(DEFAULT_FAILOVER_LANES);
  });

  it('dedupes lanes that match the primary', () => {
    const lanes = resolveLanes(primary, {
      lanes: [lane('vercel-ai-gateway', 'openai/gpt-5.4'), lane('openai', 'gpt-5.4')],
    });
    expect(lanes).toEqual([lane('openai', 'gpt-5.4')]);
  });

  it('dedupes repeated fallback lanes and honors order', () => {
    const lanes = resolveLanes(primary, {
      lanes: [lane('openai', 'a'), lane('openai', 'b'), lane('openai', 'a')],
    });
    expect(lanes).toEqual([lane('openai', 'a'), lane('openai', 'b')]);
  });

  it('tries same-provider models before cross-provider lanes', () => {
    const lanes = resolveLanes(primary, {
      models: ['anthropic/claude-sonnet-4.6'],
      lanes: [lane('openai', 'gpt-5.4')],
    });
    expect(lanes).toEqual([
      lane('vercel-ai-gateway', 'anthropic/claude-sonnet-4.6'),
      lane('openai', 'gpt-5.4'),
    ]);
  });

  it('explicit lanes/models suppress the defaults', () => {
    const lanes = resolveLanes(primary, { lanes: [lane('ollama', 'llama3.2')] });
    expect(lanes).toEqual([lane('ollama', 'llama3.2')]);
  });
});

describe('retryableCodesFor / maxAttemptsFor', () => {
  it('defaults and caps', () => {
    expect(retryableCodesFor(true)).toEqual(DEFAULT_RETRYABLE_CODES);
    expect(retryableCodesFor({ retryableCodes: ['provider-error'] })).toEqual(['provider-error']);
    expect(retryableCodesFor(undefined)).toEqual([]);
    expect(maxAttemptsFor(true, 3)).toBe(4);
    expect(maxAttemptsFor({ maxAttempts: 2 }, 3)).toBe(2);
    expect(maxAttemptsFor({}, 3)).toBe(4);
    expect(maxAttemptsFor(undefined, 3)).toBe(1);
  });
});

describe('withFailover (non-stream)', () => {
  it('returns the primary result when it succeeds', async () => {
    const { value, target } = await withFailover(
      [lane('a', 'm1'), lane('b', 'm2')],
      async (t) => `ok-${t.providerId}`,
    );
    expect(value).toBe('ok-a');
    expect(target).toEqual(lane('a', 'm1'));
  });

  it('fails over on a 429 and reports the event', async () => {
    const events: any[] = [];
    const { value, target } = await withFailover(
      [lane('a', 'm1'), lane('b', 'm2')],
      async (t) => {
        if (t.providerId === 'a') throw new ModelHitchError('rate-limited', 'slow down', { status: 429 });
        return `ok-${t.providerId}`;
      },
      { onFailover: (ev) => events.push(ev) },
    );
    expect(value).toBe('ok-b');
    expect(target).toEqual(lane('b', 'm2'));
    expect(events).toHaveLength(1);
    expect(events[0].from).toEqual(lane('a', 'm1'));
    expect(events[0].to).toEqual(lane('b', 'm2'));
    expect(events[0].error.code).toBe('rate-limited');
    expect(events[0].attempt).toBe(1);
  });

  it('skips lanes with missing credentials silently (no event)', async () => {
    const events: any[] = [];
    const { value, target } = await withFailover(
      [lane('a', 'm1'), lane('b', 'm2'), lane('c', 'm3')],
      async (t) => {
        if (t.providerId === 'a') throw new ModelHitchError('missing-api-key', 'no key');
        if (t.providerId === 'b') throw new ModelHitchError('rate-limited', '429');
        return `ok-${t.providerId}`;
      },
      { onFailover: (ev) => events.push(ev) },
    );
    expect(value).toBe('ok-c');
    // Only the rate-limit hop produced an event; the credential hop was silent.
    expect(events).toHaveLength(1);
    expect(events[0].from).toEqual(lane('b', 'm2'));
    expect(events[0].to).toEqual(lane('c', 'm3'));
  });

  it('rethrows the FIRST error when every lane fails', async () => {
    await expect(
      withFailover(
        [lane('a', 'm1'), lane('b', 'm2')],
        async (t) => {
          if (t.providerId === 'a') throw new ModelHitchError('rate-limited', '429 first');
          throw new ModelHitchError('provider-error', '502 second');
        },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('429 first'), status: undefined });
  });

  it('propagates non-retryable errors without trying fallbacks', async () => {
    let attempts = 0;
    await expect(
      withFailover(
        [lane('a', 'm1'), lane('b', 'm2')],
        async () => {
          attempts++;
          throw new ModelHitchError('bad-request', 'bad prompt', { status: 400 });
        },
      ),
    ).rejects.toMatchObject({ code: 'bad-request' });
    expect(attempts).toBe(1);
  });

  it('honors maxAttempts', async () => {
    let attempts = 0;
    await expect(
      withFailover(
        [lane('a', 'm1'), lane('b', 'm2'), lane('c', 'm3')],
        async (t) => {
          attempts++;
          throw new ModelHitchError('rate-limited', '429');
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toThrow('429');
    expect(attempts).toBe(2);
  });
});

describe('withFailoverStream', () => {
  async function collect(iter: AsyncIterable<string>): Promise<string[]> {
    const out: string[] = [];
    for await (const v of iter) out.push(v);
    return out;
  }

  it('fails over before yielding anything and restarts cleanly', async () => {
    const events: any[] = [];
    const stream = withFailoverStream<string, FailoverTarget>(
      [lane('a', 'm1'), lane('b', 'm2')],
      async function* (t) {
        if (t.providerId === 'a') throw new ModelHitchError('rate-limited', '429');
        yield 'hello from b';
      },
      { onFailover: (ev) => events.push(ev) },
    );
    expect(await collect(stream)).toEqual(['hello from b']);
    expect(events).toHaveLength(1);
  });

  it('never retries once content has been yielded', async () => {
    const events: any[] = [];
    const stream = withFailoverStream<string, FailoverTarget>(
      [lane('a', 'm1'), lane('b', 'm2')],
      async function* (t) {
        yield 'partial';
        throw new ModelHitchError('provider-error', '502 mid-stream');
      },
      { onFailover: (ev) => events.push(ev) },
    );
    await expect(collect(stream)).rejects.toThrow('502 mid-stream');
    expect(events).toHaveLength(0); // no duplicate-output failover
  });

  it('propagates non-retryable errors', async () => {
    const stream = withFailoverStream<string, FailoverTarget>(
      [lane('a', 'm1'), lane('b', 'm2')],
      async function* () {
        throw new ModelHitchError('bad-request', 'nope', { status: 400 });
      },
    );
    await expect(collect(stream)).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('skips credential-less lanes silently', async () => {
    const events: any[] = [];
    const stream = withFailoverStream<string, FailoverTarget>(
      [lane('a', 'm1'), lane('b', 'm2'), lane('c', 'm3')],
      async function* (t) {
        if (t.providerId === 'a') throw new ModelHitchError('missing-api-key', 'no key');
        if (t.providerId === 'b') throw new ModelHitchError('rate-limited', '429');
        yield 'from c';
      },
      { onFailover: (ev) => events.push(ev) },
    );
    expect(await collect(stream)).toEqual(['from c']);
    expect(events).toHaveLength(1);
  });
});
