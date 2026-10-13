import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  MemoryKeyStore,
  MemoryLaneCooldown,
  ModelHitch,
  ModelHitchError,
  createRegistrySource,
  errorInfo,
  parseRetryAfter,
  resolvePolicyLanes,
  validatePolicy,
  withFailover,
  withFailoverStream,
  type FailoverTarget,
  type Policy,
  type Provider,
  type ProviderSource,
} from '../src/index.js';

const lane = (providerId: string, model: string): FailoverTarget => ({ providerId, model });

function fakeProvider(
  id: string,
  defaultModel: string,
  opts: { chatError?: ModelHitchError } = {},
): Provider {
  return {
    id,
    name: id,
    defaultModel,
    capabilities: { streaming: true, toolCalling: true, vision: true, embeddings: false },
    chat: async () => {
      if (opts.chatError) throw opts.chatError;
      return { message: { role: 'assistant', content: `ok-${id}` }, finishReason: 'stop' };
    },
    stream: async function* () {
      if (opts.chatError) throw opts.chatError;
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
}

const providers = [
  fakeProvider('alpha', 'a-model'),
  fakeProvider('beta', 'b-model'),
  fakeProvider('gamma', 'c-model'),
];
const source = createRegistrySource(providers);

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('45')).toBe(45_000);
    expect(parseRetryAfter('45.5')).toBe(45_500);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses HTTP-dates in the future', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(61_000);
  });

  it('returns undefined for past, garbage, and empty values', () => {
    expect(parseRetryAfter('Mon, 01 Jan 2020 00:00:00 GMT')).toBeUndefined();
    expect(parseRetryAfter('later than later')).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe('MemoryLaneCooldown', () => {
  it('is usable until cooled, and cools per-lane (the lane is the trust object)', () => {
    let now = 1_000;
    const cd = new MemoryLaneCooldown({ now: () => now });
    const a = lane('openai', 'gpt-5.5');
    const b = lane('openai', 'gpt-5-mini');
    expect(cd.cooldownMs(a)).toBe(0);

    cd.cool(a, 10_000);
    expect(cd.cooldownMs(a)).toBe(10_000);
    expect(cd.cooldownMs(b)).toBe(0); // same provider, different lane: unaffected

    now += 10_001;
    expect(cd.cooldownMs(a)).toBe(0);
  });

  it('applies graceMs when no Retry-After was provided', () => {
    const cd = new MemoryLaneCooldown({ now: () => 0, graceMs: 2_500 });
    cd.cool(lane('a', 'm'));
    expect(cd.cooldownMs(lane('a', 'm'))).toBe(2_500);
  });

  it('honors an explicit Retry-After over grace', () => {
    const cd = new MemoryLaneCooldown({ now: () => 0, graceMs: 5_000 });
    cd.cool(lane('a', 'm'), 60_000);
    expect(cd.cooldownMs(lane('a', 'm'))).toBe(60_000);
  });

  it('clear() resets everything', () => {
    const cd = new MemoryLaneCooldown({ now: () => 0 });
    cd.cool(lane('a', 'm'), 10_000);
    cd.clear();
    expect(cd.cooldownMs(lane('a', 'm'))).toBe(0);
  });

  it('success() drops a stale cooldown', () => {
    const cd = new MemoryLaneCooldown({ now: () => 0 });
    const t = lane('a', 'm');
    cd.cool(t, 10_000);
    expect(cd.cooldownMs(t)).toBe(10_000);
    cd.success(t);
    expect(cd.cooldownMs(t)).toBe(0);
  });
});

describe('validatePolicy', () => {
  it('accepts a valid policy with no errors', () => {
    const v = validatePolicy(
      { trusted: [{ providerId: 'alpha', models: ['a-model'] }], fallback: [{ providerId: 'beta' }] },
      source,
    );
    expect(v.errors).toEqual([]);
  });

  it('requires at least one entry', () => {
    const v = validatePolicy({ trusted: [], fallback: [] }, source);
    expect(v.errors.join('\n')).toContain('at least one entry');
  });

  it('rejects unknown providers with the known list', () => {
    const v = validatePolicy({ trusted: [{ providerId: 'nope' }], fallback: [] }, source);
    expect(v.errors.join('\n')).toContain('unknown provider "nope"');
    expect(v.errors.join('\n')).toContain('alpha');
  });

  it('rejects entries without a providerId', () => {
    const v = validatePolicy({ trusted: [{} as never], fallback: [] }, source);
    expect(v.errors.join('\n')).toContain('non-empty providerId');
  });

  it('rejects non-array trusted/fallback and malformed models', () => {
    expect(validatePolicy({ trusted: 'x' as never, fallback: [] }, source).errors.length).toBeGreaterThan(0);
    const v = validatePolicy(
      { trusted: [{ providerId: 'alpha', models: 'a-model' as never }], fallback: [] },
      source,
    );
    expect(v.errors.join('\n')).toContain('must be an array');
  });

  it('validates maxProviders, backoff, and retryableCodes', () => {
    expect(validatePolicy({ trusted: [], fallback: [{ providerId: 'alpha' }], maxProviders: 0 }, source).errors.length).toBeGreaterThan(0);
    expect(
      validatePolicy(
        { trusted: [{ providerId: 'alpha' }], fallback: [], backoff: { type: 'exponential', baseMs: -1 } },
        source,
      ).errors.length,
    ).toBeGreaterThan(0);
    expect(
      validatePolicy(
        { trusted: [{ providerId: 'alpha' }], fallback: [], backoff: { type: 'fixed', baseMs: 100, maxMs: 50 } },
        source,
      ).errors.length,
    ).toBeGreaterThan(0);
    expect(
      validatePolicy(
        { trusted: [{ providerId: 'alpha' }], fallback: [], retryableCodes: ['not-a-code' as never] },
        source,
      ).errors.length,
    ).toBeGreaterThan(0);
  });

  it('warns when models are missing from an enumerable source', () => {
    const enumerable: ProviderSource = {
      ...source,
      modelsFor: () => ['a-model'],
    };
    const v = validatePolicy(
      { trusted: [{ providerId: 'alpha', models: ['a-model', 'ghost-model'] }], fallback: [] },
      enumerable,
    );
    expect(v.errors).toEqual([]);
    expect(v.warnings.join('\n')).toContain('ghost-model');
  });
});

describe('resolvePolicyLanes', () => {
  const policy: Policy = {
    trusted: [
      { providerId: 'alpha', models: ['a-model'] },
      { providerId: 'beta' }, // no models → default
    ],
    fallback: [{ providerId: 'gamma', models: ['c-model'] }],
  };

  it('orders primary, then trusted, then fallback', () => {
    const targets = resolvePolicyLanes(policy, lane('weird', 'custom'), source);
    expect(targets).toEqual([
      lane('weird', 'custom'),
      lane('alpha', 'a-model'),
      lane('beta', 'b-model'),
      lane('gamma', 'c-model'),
    ]);
  });

  it('expands provider→models and uses the default when models are omitted', () => {
    const targets = resolvePolicyLanes(
      { trusted: [{ providerId: 'alpha', models: ['m1', 'm2'] }], fallback: [] },
      lane('alpha', 'm1'),
      source,
    );
    // primary deduped; both explicit models survive
    expect(targets).toEqual([lane('alpha', 'm1'), lane('alpha', 'm2')]);
  });

  it('trusted duplicates of the primary are deduped', () => {
    const targets = resolvePolicyLanes(
      { trusted: [{ providerId: 'alpha', models: ['a-model'] }], fallback: [] },
      lane('alpha', 'a-model'),
      source,
    );
    expect(targets).toEqual([lane('alpha', 'a-model')]);
  });

  it('trusted wins over a fallback duplicate', () => {
    const targets = resolvePolicyLanes(
      {
        trusted: [{ providerId: 'alpha', models: ['a-model'] }],
        fallback: [{ providerId: 'alpha', models: ['a-model', 'other'] }],
      },
      lane('beta', 'b-model'),
      source,
    );
    expect(targets).toEqual([lane('beta', 'b-model'), lane('alpha', 'a-model'), lane('alpha', 'other')]);
  });

  it('maxProviders trims the lowest-priority (tail) lanes until the cap holds', () => {
    const targets = resolvePolicyLanes(
      { ...policy, maxProviders: 2 },
      lane('weird', 'custom'),
      source,
    );
    expect(targets).toEqual([lane('weird', 'custom'), lane('alpha', 'a-model')]);
  });

  it('maxProviders: 1 keeps only the primary', () => {
    const targets = resolvePolicyLanes({ ...policy, maxProviders: 1 }, lane('alpha', 'a-model'), source);
    expect(targets).toEqual([lane('alpha', 'a-model')]);
  });

  it('never trims the primary even with a tiny cap', () => {
    const targets = resolvePolicyLanes({ ...policy, maxProviders: 1 }, lane('weird', 'custom'), source);
    expect(targets).toEqual([lane('weird', 'custom')]);
  });
});

describe('withFailover cooldown + delay + exhaustion sockets', () => {
  it('skips cooled lanes without attempting them', async () => {
    const attempted: string[] = [];
    const cd = new MemoryLaneCooldown({ now: () => 0 });
    cd.cool(lane('a', 'm1'), 10_000);
    const { value, target } = await withFailover(
      [lane('a', 'm1'), lane('b', 'm2')],
      async (t) => {
        attempted.push(t.providerId);
        return `ok-${t.providerId}`;
      },
      { cooldown: cd },
    );
    expect(attempted).toEqual(['b']);
    expect(value).toBe('ok-b');
    expect(target).toEqual(lane('b', 'm2'));
  });

  it('cools the failed lane on a retryable error with Retry-After', async () => {
    const cd = new MemoryLaneCooldown({ now: () => 0 });
    await withFailover(
      [lane('a', 'm1'), lane('b', 'm2')],
      async (t) => {
        if (t.providerId === 'a') {
          throw new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 30_000 });
        }
        return 'ok';
      },
      { cooldown: cd },
    );
    expect(cd.cooldownMs(lane('a', 'm1'))).toBe(30_000);
  });

  it('reports exhaustion with per-lane diagnostics', async () => {
    const exhausted: any[] = [];
    await expect(
      withFailover(
        [lane('a', 'm1'), lane('b', 'm2')],
        async (t) => {
          if (t.providerId === 'a') throw new ModelHitchError('rate-limited', '429 first');
          throw new ModelHitchError('provider-error', '502 second');
        },
        { onExhausted: (info) => exhausted.push(info) },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('429 first') });
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].targets).toEqual([lane('a', 'm1'), lane('b', 'm2')]);
    expect(exhausted[0].attempts.map((a: { target: FailoverTarget; error: { code: string } }) => a.target)).toEqual([
      lane('a', 'm1'),
      lane('b', 'm2'),
    ]);
    expect(exhausted[0].attempts[1].error.code).toBe('provider-error');
  });

  it('throws a clear error when every lane is on cooldown (nothing attempted)', async () => {
    const cd = new MemoryLaneCooldown({ now: () => 0 });
    cd.cool(lane('a', 'm1'), 10_000);
    cd.cool(lane('b', 'm2'), 10_000);
    await expect(
      withFailover(
        [lane('a', 'm1'), lane('b', 'm2')],
        async () => 'unreachable',
        { cooldown: cd, onExhausted: (info) => expect(info.attempts).toEqual([]) },
      ),
    ).rejects.toMatchObject({ code: 'provider-error' });
  });

  it('surfaces a credential error on a single-lane walk (no synthetic provider-error)', async () => {
    await expect(
      withFailover(
        [lane('a', 'm1')],
        async () => {
          throw new ModelHitchError('missing-api-key', 'no key configured');
        },
      ),
    ).rejects.toMatchObject({ code: 'missing-api-key' });
  });

  it('surfaces the first real error when the final lane lacks credentials', async () => {
    await expect(
      withFailover(
        [lane('a', 'm1'), lane('b', 'm2')],
        async (t) => {
          if (t.providerId === 'a') throw new ModelHitchError('rate-limited', '429 first');
          throw new ModelHitchError('missing-api-key', 'no key for b');
        },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('429 first') });
  });

  it('surfaces the FIRST error when the final lane fails non-retryably (contract preservation)', async () => {
    // Regression pin: pre-M1, a final-lane non-retryable error surfaced the
    // first error (the lane the user actually configured), not the last.
    await expect(
      withFailover(
        [lane('a', 'm1'), lane('b', 'm2')],
        async (t) => {
          if (t.providerId === 'a') throw new ModelHitchError('rate-limited', '429 first', { status: 429 });
          throw new ModelHitchError('bad-request', '400 last', { status: 400 });
        },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('429 first') });
  });

  it('cools the FINAL lane too when it fails retryably (no immediate re-walk)', async () => {
    const cd = new MemoryLaneCooldown({ now: () => 0 });
    await expect(
      withFailover(
        [lane('a', 'm1'), lane('b', 'm2'), lane('c', 'm3')],
        async (t) => {
          if (t.providerId === 'a') throw new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 30_000 });
          if (t.providerId === 'b') throw new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 5_000 });
          throw new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 60_000 });
        },
        { cooldown: cd },
      ),
    ).rejects.toMatchObject({ code: 'rate-limited' });
    expect(cd.cooldownMs(lane('a', 'm1'))).toBe(30_000);
    expect(cd.cooldownMs(lane('b', 'm2'))).toBe(5_000);
    expect(cd.cooldownMs(lane('c', 'm3'))).toBe(60_000); // the final lane is NOT left hot
  });

  it('rethrows the final lane mid-stream error when content was already yielded', async () => {
    const stream = withFailoverStream<string, FailoverTarget>(
      [lane('a', 'm1'), lane('b', 'm2')],
      async function* (t) {
        yield 'partial from last';
        throw new ModelHitchError('rate-limited', '429 after partial', { status: 429 });
      },
    );
    const out: string[] = [];
    await expect(async () => {
      for await (const v of stream) out.push(v);
    }).rejects.toMatchObject({ message: '429 after partial' });
    expect(out).toEqual(['partial from last']);
  });

  it('invokes delayMsBeforeFailover before switching (opt-in waiting)', async () => {
    const delays: Array<{ target: FailoverTarget; ms: number }> = [];
    const { value } = await withFailover(
      [lane('a', 'm1'), lane('b', 'm2')],
      async (t) => {
        if (t.providerId === 'a') throw new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 999 });
        return 'ok';
      },
      {
        delayMsBeforeFailover: (from, err, attempt) => {
          const ms = 0; // zero keeps tests instant; the wiring is what we assert
          delays.push({ target: from, ms });
          return ms;
        },
      },
    );
    expect(value).toBe('ok');
    expect(delays).toHaveLength(1);
    expect(delays[0]!.target).toEqual(lane('a', 'm1'));
  });

  it('propagates retryAfterMs through errorInfo', () => {
    expect(
      errorInfo(new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 45_000 })),
    ).toMatchObject({ code: 'rate-limited', retryAfterMs: 45_000 });
  });
});

describe('ModelHitch policy wiring', () => {
  it('rejects policy + autoMode together', () => {
    expect(
      () => new ModelHitch({ providers, autoMode: true, policy: { trusted: [{ providerId: 'alpha' }], fallback: [] } }),
    ).toThrow(/either "policy" or "autoMode"/);
  });

  it('rejects an invalid policy at construction', () => {
    expect(
      () => new ModelHitch({ providers, policy: { trusted: [{ providerId: 'ghost' }], fallback: [] } }),
    ).toThrow(/unknown provider "ghost"/);
  });

  it('routes calls through the policy lane order and fails over on 429', async () => {
    const alpha = fakeProvider('alpha', 'a-model', { chatError: new ModelHitchError('rate-limited', '429', { status: 429 }) });
    const mh = new ModelHitch({
      providers: [alpha, fakeProvider('beta', 'b-model'), fakeProvider('gamma', 'c-model')],
      policy: {
        trusted: [{ providerId: 'alpha', models: ['a-model'] }, { providerId: 'beta', models: ['b-model'] }],
        fallback: [{ providerId: 'gamma', models: ['c-model'] }],
      },
    });
    const result = await mh.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.message.content).toBe('ok-beta');
  });

  it('walks every lane, reports exhaustion, and surfaces the first error', async () => {
    const exhausted: any[] = [];
    const mh = new ModelHitch({
      providers: [
        fakeProvider('alpha', 'a-model', { chatError: new ModelHitchError('rate-limited', '429', { status: 429 }) }),
        fakeProvider('beta', 'b-model', { chatError: new ModelHitchError('provider-error', '502', { status: 502 }) }),
      ],
      policy: {
        trusted: [{ providerId: 'alpha', models: ['a-model'] }],
        fallback: [{ providerId: 'beta', models: ['b-model'] }],
      },
      onExhausted: (info) => exhausted.push(info),
    });
    await expect(mh.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'rate-limited',
      message: expect.stringContaining('429'),
    });
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0].attempts).toHaveLength(2);
  });

  it('keeps existing autoMode behavior untouched', async () => {
    const mh = new ModelHitch({ providers, autoMode: { lanes: [lane('beta', 'b-model')] } });
    const alpha = providers[0]!;
    const targets = (mh as unknown as { failoverTargets(p: string, m: string): FailoverTarget[] }).failoverTargets(
      alpha.id,
      'a-model',
    );
    expect(targets).toEqual([lane('alpha', 'a-model'), lane('beta', 'b-model')]);
  });

  it('registry policy mode defaults to MemoryLaneCooldown (M1 behavior preserved)', () => {
    const mh = new ModelHitch({
      providers,
      policy: { trusted: [{ providerId: 'alpha' }], fallback: [] },
    });
    expect(mh.cooldown).toBeInstanceOf(MemoryLaneCooldown);
    expect(mh.laneHealth).toEqual([]); // no breaker → no health snapshot
  });

  it('honors an explicit cooldown override', () => {
    const breaker = new CircuitBreaker();
    const mh = new ModelHitch({
      providers,
      policy: { trusted: [{ providerId: 'alpha' }], fallback: [] },
      cooldown: breaker,
    });
    expect(mh.cooldown).toBe(breaker);
  });

  it('backoff maxMs is a hard cap that wins over Retry-After (bounded politeness)', () => {
    // The policy is a parameter rather than instance state: a plan is per-call
    // once intents exist, so the walk is handed the one the call resolved to.
    const capped: Policy = {
      trusted: [{ providerId: 'alpha' }],
      fallback: [],
      backoff: { type: 'fixed', baseMs: 100, maxMs: 500 },
    };
    const mh = new ModelHitch({ providers, policy: capped });
    const delay = (mh as unknown as {
      delayBeforeFailover(
        policy: Policy | undefined,
        from: FailoverTarget,
        err: unknown,
        attempt: number,
      ): number | undefined;
    }).delayBeforeFailover.bind(mh);
    // Retry-After says 3s, but the user's cap says at most 500ms — cap wins.
    expect(
      delay(capped, lane('alpha', 'a-model'), new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 3_000 }), 1),
    ).toBe(500);

    // Without a cap, Retry-After raises the wait above the base.
    const uncapped: Policy = {
      trusted: [{ providerId: 'alpha' }],
      fallback: [],
      backoff: { type: 'exponential', baseMs: 100 },
    };
    const mh2 = new ModelHitch({ providers, policy: uncapped });
    const delay2 = (mh2 as unknown as {
      delayBeforeFailover(
        policy: Policy | undefined,
        from: FailoverTarget,
        err: unknown,
        attempt: number,
      ): number | undefined;
    }).delayBeforeFailover.bind(mh2);
    expect(
      delay2(uncapped, lane('alpha', 'a-model'), new ModelHitchError('rate-limited', '429', { status: 429, retryAfterMs: 3_000 }), 1),
    ).toBe(3_000);
    // Exponential growth applies per attempt when no Retry-After:
    // 100 * 2^(3-1) = 400.
    expect(
      delay2(uncapped, lane('alpha', 'a-model'), new ModelHitchError('provider-error', '502', { status: 502 }), 3),
    ).toBe(400);
  });
});