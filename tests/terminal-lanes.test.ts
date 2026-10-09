import { describe, expect, it, vi } from 'vitest';
import {
  CircuitBreaker,
  MemoryLaneCooldown,
  ModelHitch,
  ModelHitchError,
  createRegistrySource,
  isExhaustedError,
  resolvePolicyLanes,
  validatePolicy,
  withFailover,
  withFailoverStream,
  type FailoverErrorInfo,
  type FailoverTarget,
  type Policy,
  type Provider,
} from '../src/index.js';

/**
 * Terminal ("stop on limit") lanes.
 *
 * A custom BYOK lane whose owner opted out of failover is the end of the walk:
 * when it is rate limited or out of credit, the request must fail in that lane's
 * own terms instead of quietly spending a different provider's quota. These
 * tests pin that — including the parked case, where the lane is still cooling
 * from the earlier failure and must not hand the request to the next lane.
 */

function lane(providerId: string, terminal = false): FailoverTarget {
  return { providerId, model: 'm', ...(terminal ? { terminal: true } : {}) };
}

function rateLimited(providerId: string): ModelHitchError {
  return new ModelHitchError('rate-limited', `${providerId} is out of credit`, {
    status: 429,
    providerId,
    retryAfterMs: 30_000,
  });
}

describe('withFailover honors a terminal lane', () => {
  it('stops the walk instead of rotating past a stop-on-limit lane', async () => {
    const attempted: string[] = [];
    const targets = [lane('metered', true), lane('expensive')];
    const err = await withFailover(
      targets,
      async (target) => {
        attempted.push(target.providerId);
        throw rateLimited(target.providerId);
      },
    ).catch((e: unknown) => e);

    expect(isExhaustedError(err)).toBe(true);
    // The lane behind the terminal one was never spent.
    expect(attempted).toEqual(['metered']);
    // …and the caller sees the real cause: their own lane's 429.
    expect((err as ModelHitchError).code).toBe('rate-limited');
    expect((err as ModelHitchError).status).toBe(429);
    expect((err as ModelHitchError).message).toContain('metered is out of credit');
  });

  it('keeps rotating when the lane did not opt out', async () => {
    const attempted: string[] = [];
    const { value } = await withFailover([lane('metered'), lane('expensive')], async (target) => {
      attempted.push(target.providerId);
      if (target.providerId === 'metered') throw rateLimited('metered');
      return 'served by expensive';
    });
    expect(attempted).toEqual(['metered', 'expensive']);
    expect(value).toBe('served by expensive');
  });

  it('stops on a parked stop-on-limit lane and reports the recorded failure', async () => {
    const cooldown = new MemoryLaneCooldown({ graceMs: 30_000 });
    const attempted: string[] = [];
    const targets = [lane('metered', true), lane('expensive')];
    const call = () =>
      withFailover(
        targets,
        async (target) => {
          attempted.push(target.providerId);
          if (target.providerId === 'metered') throw rateLimited('metered');
          return 'served by expensive';
        },
        { cooldown },
      );

    await expect(call()).rejects.toBeInstanceOf(ModelHitchError);
    expect(attempted).toEqual(['metered']);

    // Second request, still inside the cooldown window: the parked lane ends the
    // walk rather than falling through to the lane behind it.
    const parked = await call().catch((e: unknown) => e);
    expect(attempted).toEqual(['metered']);
    expect((parked as ModelHitchError).code).toBe('rate-limited');
    expect((parked as ModelHitchError).status).toBe(429);
    expect((parked as ModelHitchError).message).toContain('still parked');
    expect((parked as ModelHitchError).message).toContain('metered is out of credit');

    // A lane that is NOT terminal is still skipped on cooldown and rotates on:
    // the parked call above attempted nothing, this one attempts `expensive`.
    const rotatingTargets = [lane('metered'), lane('expensive')];
    cooldown.cool(rotatingTargets[0]!, 30_000);
    const rotated = await withFailover(
      rotatingTargets,
      async (target) => {
        attempted.push(target.providerId);
        return 'served by expensive';
      },
      { cooldown },
    );
    expect(attempted).toEqual(['metered', 'expensive']);
    expect(rotated.value).toBe('served by expensive');
  });

  it('survives a cooldown engine that keeps no failure record', async () => {
    // Only the timestamp is known: the message has to stand on its own.
    const bare = {
      cooldownMs: () => 5_000,
      cool: () => {},
    };
    const err = await withFailover(
      [lane('metered', true), lane('expensive')],
      async (target) => {
        throw rateLimited(target.providerId);
      },
      { cooldown: bare },
    ).catch((e: unknown) => e);
    expect(isExhaustedError(err)).toBe(true);
    expect((err as ModelHitchError).message).toContain('no other lane was tried');
  });

  it('stops a streaming walk before any chunk is emitted', async () => {
    let expensiveCalls = 0;
    const chunks: string[] = [];
    const stream = withFailoverStream(
      [lane('metered', true), lane('expensive')],
      (target) =>
        (async function* () {
          if (target.providerId === 'metered') throw rateLimited('metered');
          expensiveCalls += 1;
          yield 'expensive chunk';
        })(),
    );
    const err = await (async () => {
      try {
        for await (const chunk of stream) chunks.push(chunk);
      } catch (e) {
        return e;
      }
    })();
    expect(chunks).toEqual([]);
    expect(expensiveCalls).toBe(0);
    expect((err as ModelHitchError).code).toBe('rate-limited');
  });

  it('reports the parked lane through the circuit breaker too', async () => {
    const breaker = new CircuitBreaker({ graceMs: 30_000, rateLimitTripsImmediately: true });
    const attempted: string[] = [];
    const targets = [lane('metered', true), lane('expensive')];
    const call = () =>
      withFailover(
        targets,
        async (target) => {
          attempted.push(target.providerId);
          if (target.providerId === 'metered') throw rateLimited('metered');
          return 'served by expensive';
        },
        { cooldown: breaker },
      );

    await call().catch(() => undefined);
    const parked = await call().catch((e: unknown) => e);
    expect(attempted).toEqual(['metered']);
    expect((parked as ModelHitchError).code).toBe('rate-limited');
    expect((parked as ModelHitchError).message).toContain('still parked');
  });
});

describe('policy carries the terminal flag', () => {
  const providers: Provider[] = [
    { id: 'metered', name: 'Metered', defaultModel: 'm', capabilities: { streaming: true, toolCalling: true, vision: false, embeddings: false }, chat: async () => ({ message: { role: 'assistant', content: '' }, finishReason: 'stop' }), stream: async function* () {} },
    { id: 'expensive', name: 'Expensive', defaultModel: 'm', capabilities: { streaming: true, toolCalling: true, vision: false, embeddings: false }, chat: async () => ({ message: { role: 'assistant', content: '' }, finishReason: 'stop' }), stream: async function* () {} },
  ];
  const source = createRegistrySource(providers);

  it('marks the resolved target, even when the lane is the caller primary', () => {
    const policy: Policy = {
      trusted: [{ providerId: 'metered', models: ['m'], terminal: true }],
      fallback: [{ providerId: 'expensive', models: ['m'] }],
    };
    // Primary route is the terminal lane itself — the common case, and the one
    // where a naive "already seen" dedupe would drop the flag.
    const targets = resolvePolicyLanes(policy, { providerId: 'metered', model: 'm' }, source);
    expect(targets.map((t) => t.providerId)).toEqual(['metered', 'expensive']);
    expect(targets[0]?.terminal).toBe(true);
    expect(targets[1]?.terminal).toBeUndefined();
  });

  it('validates the flag type', () => {
    const bad = validatePolicy(
      { trusted: [{ providerId: 'metered', terminal: 'yes' as never }], fallback: [] },
      source,
    );
    expect(bad.errors.join('\n')).toMatch(/"terminal" must be a boolean/);
    expect(validatePolicy({ trusted: [{ providerId: 'metered', terminal: true }], fallback: [] }, source).errors).toEqual([]);
  });

  it('keeps stop-on-limit through the client failover path', async () => {
    const attempted: string[] = [];
    const failing = (id: string, err: ModelHitchError): Provider => ({
      id,
      name: id,
      defaultModel: 'm',
      capabilities: { streaming: true, toolCalling: true, vision: false, embeddings: false },
      chat: async () => {
        attempted.push(id);
        throw err;
      },
      stream: async function* () {
        attempted.push(id);
        throw err;
      },
    });

    const client = new ModelHitch({
      providers: [
        failing('metered', rateLimited('metered')),
        failing('expensive', new ModelHitchError('provider-error', 'should never be reached')),
      ],
      policy: {
        trusted: [{ providerId: 'metered', models: ['m'], terminal: true }],
        fallback: [{ providerId: 'expensive', models: ['m'] }],
      },
    });

    const err = await client.chat({ provider: 'metered', model: 'm', messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e);
    expect(attempted).toEqual(['metered']);
    expect(err).toBeInstanceOf(ModelHitchError);
    expect((err as ModelHitchError).code).toBe('rate-limited');
    expect((err as ModelHitchError).message).toContain('metered is out of credit');
  });
});
