import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FREE_MODEL_ID,
  createModelHitchServer,
  createOpenAICompatibleProvider,
  isFreeLaneModel,
  isFreeModelId,
  freeModelEntry,
  freeModelLabel,
  mockProvider,
  type OpenAICompatibleServer,
  type Policy,
  type Provider,
} from '../src/index.js';

/**
 * The free-only plan: `modelhitch/free` as a pickable model, `policy.freeOnly`
 * as a pin, and `isFreeLaneModel` as the definition of "costs nothing".
 *
 * The contract the tests are about: the free id is a *plan selector*, not a
 * lane — it routes exactly as a request with no model does, and then the lane
 * walk keeps only lanes that can never bill anyone. An empty filtered walk is
 * refused (404) rather than silently served from a billable lane.
 */

describe('isFreeLaneModel', () => {
  it('treats the OpenCode Go subscription lane as free regardless of model id', () => {
    expect(isFreeLaneModel('go-pro', 'opencode-go')).toBe(true);
    expect(isFreeLaneModel('anything/at/all', 'opencode-go')).toBe(true);
  });

  it('treats local providers as free', () => {
    expect(isFreeLaneModel('llama-3-local', 'ollama')).toBe(true);
    expect(isFreeLaneModel('qwen-4b', 'lmstudio')).toBe(true);
    expect(isFreeLaneModel('gemma', 'vllm')).toBe(true);
  });

  it('treats an explicit `-free` id as free, namespaced or not', () => {
    expect(isFreeLaneModel('kimi-k2.6-free')).toBe(true);
    expect(isFreeLaneModel('opencode/kimi-k2.6-free')).toBe(true);
    expect(isFreeLaneModel('space-bunny-free', 'opencode')).toBe(true);
  });

  it('treats an exact zero-priced model pricing entry as free', () => {
    // `big-pickle` is 0/0 in MODEL_PRICING but does not end in `-free`.
    expect(isFreeLaneModel('big-pickle')).toBe(true);
    expect(isFreeLaneModel('opencode/big-pickle')).toBe(true);
  });

  it('excludes paid and unknown ids — the filter narrows, never widens', () => {
    expect(isFreeLaneModel('glm-5.1')).toBe(false); // exact paid entry
    expect(isFreeLaneModel('openai/gpt-5.4')).toBe(false); // priced by family fallback
    expect(isFreeLaneModel('totally-unknown-model')).toBe(false); // unpriced: could cost anything
  });
});

describe('isFreeModelId', () => {
  it('matches the free plan id exactly, trimming and case-insensitively', () => {
    expect(isFreeModelId('modelhitch/free')).toBe(true);
    expect(isFreeModelId('  MODELHITCH/FREE ')).toBe(true);
  });

  it('leaves everything else alone — lanes and other plan ids included', () => {
    expect(isFreeModelId('modelhitch/auto')).toBe(false);
    expect(isFreeModelId('zen/kimi-k2.6')).toBe(false);
    expect(isFreeModelId(undefined)).toBe(false);
    expect(isFreeModelId(42)).toBe(false);
  });
});

describe('freeModelEntry / freeModelLabel', () => {
  it('labels the plan by its free lane count, singular and plural', () => {
    expect(freeModelLabel(1)).toBe('ModelHitch Free · free lanes only · 1 lane');
    expect(freeModelLabel(2)).toBe('ModelHitch Free · free lanes only · 2 lanes');
    expect(freeModelLabel(0)).toBe('ModelHitch Free · no free lanes');
  });

  it('builds a plan entry carrying exactly the lanes it was given', () => {
    const lane = {
      id: 'opencode-go/go-pro',
      providerId: 'opencode-go',
      model: 'go-pro',
      tier: 'trusted' as const,
      laneIndex: 1,
      terminal: false,
      name: 'Go Pro · OpenCode Go · trusted lane 1',
    };
    const entry = freeModelEntry([lane], 3);
    expect(entry.id).toBe(FREE_MODEL_ID);
    expect(entry.name).toBe('ModelHitch Free · free lanes only · 1 lane');
    expect(entry.modelhitch).toEqual({ kind: 'free', lanes: [lane] });
  });
});

// ---------------------------------------------------------------------------
// Server behavior
// ---------------------------------------------------------------------------

/** A non-free lane provider: any attempt to serve through it is observable. */
let paidCalls = 0;
const paidProvider: Provider = {
  id: 'paid',
  name: 'Paid Lane',
  defaultModel: 'paid-model',
  capabilities: { streaming: false, toolCalling: false, vision: false, embeddings: false },
  async chat() {
    paidCalls += 1;
    return {
      message: { role: 'assistant', content: 'PAID REPLY' },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
  async *stream() {
    paidCalls += 1;
    yield { type: 'text-delta' as const, text: 'PAID REPLY' };
    yield { type: 'finish' as const, finishReason: 'stop' };
  },
};

/** A free lane: the `-free` suffix brands the model, on the mock provider. */
const freePolicy: Policy = {
  trusted: [{ providerId: 'paid', models: ['paid-model'] }, { providerId: 'paid', models: ['paid-model-2'] }],
  fallback: [{ providerId: 'mock', models: ['mock-free'] }],
};

const noFreePolicy: Policy = {
  trusted: [{ providerId: 'paid', models: ['paid-model'] }],
  fallback: [{ providerId: 'mock', models: ['mock-model'] }],
};

type ErrorBody = { error: { message: string } };

async function chat(base: string, model: string | undefined): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(model !== undefined ? { model } : {}),
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

describe('POST /v1/chat/completions with model=modelhitch/free', () => {
  let server: OpenAICompatibleServer;
  let base: string;

  beforeAll(async () => {
    paidCalls = 0;
    server = createModelHitchServer({
      providers: [paidProvider, mockProvider],
      defaultProviderId: 'paid',
      policy: freePolicy,
    });
    base = (await server.listen(0, '127.0.0.1')).url;
  });

  afterAll(async () => {
    await server.close();
  });

  it('routes as an unqualified request but serves only the free lanes', async () => {
    const res = await chat(base, FREE_MODEL_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; choices: Array<{ message: { content: string } }> };
    // The mock lane answered — never a billable one, and no failover reached
    // the paid lanes on the way.
    expect(body.choices[0]?.message.content).toBe('Mock reply: hi');
    expect(paidCalls).toBe(0);
  });

  it('publishes the free plan row in /v1/models', async () => {
    const data = ((await (await fetch(`${base}/v1/models`)).json()) as {
      data: Array<{
        id: string;
        name?: string;
        owned_by: string;
        modelhitch?: { kind: string; lanes: Array<{ id: string; tier: string; model: string }> };
      }>;
    }).data;
    const free = data.find((entry) => entry.id === FREE_MODEL_ID);
    expect(free?.owned_by).toBe('modelhitch');
    expect(free?.name).toBe('ModelHitch Free · free lanes only · 1 lane');
    expect(free?.modelhitch?.kind).toBe('free');
    // The entry lists the walk the id will take — the free lanes only.
    expect(free?.modelhitch?.lanes.map((lane) => lane.model)).toEqual(['mock-free']);
    expect(data[0]?.id).toBe('modelhitch/auto');
  });

  it('answers GET /v1/models/:id for model=…/free like it does for the auto id', async () => {
    const res = await fetch(`${base}/v1/models/${FREE_MODEL_ID}`);
    expect(res.status).toBe(200);
    const entry = (await res.json()) as { id: string; modelhitch: { kind: string } };
    expect(entry.id).toBe(FREE_MODEL_ID);
    expect(entry.modelhitch.kind).toBe('free');
  });
});

describe('policy.freeOnly (no model id needed)', () => {
  it('filters the walk the same way the free id does', async () => {
    paidCalls = 0;
    const server = createModelHitchServer({
      providers: [paidProvider, mockProvider],
      defaultProviderId: 'paid',
      policy: { ...freePolicy, freeOnly: true },
    });
    try {
      const base = (await server.listen(0, '127.0.0.1')).url;
      const res = await chat(base, undefined);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]?.message.content).toBe('Mock reply: hi');
      expect(paidCalls).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe('POST /v1/chat/completions with model=modelhitch/free and no free lanes', () => {
  it('answers 404 with the free-lane explanation instead of billing silently', async () => {
    const server = createModelHitchServer({
      providers: [paidProvider, mockProvider],
      defaultProviderId: 'paid',
      policy: noFreePolicy,
    });
    try {
      const base = (await server.listen(0, '127.0.0.1')).url;
      const res = await chat(base, FREE_MODEL_ID);
      expect(res.status).toBe(404);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.message).toContain('nothing to serve');
      // A plan that filters everything away must never fall through to a
      // billable lane "just to answer something".
      expect(paidCalls).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('publishes no free row when the plan has no free lane', async () => {
    const server = createModelHitchServer({
      providers: [paidProvider, mockProvider],
      defaultProviderId: 'paid',
      policy: noFreePolicy,
    });
    try {
      const base = (await server.listen(0, '127.0.0.1')).url;
      const data = ((await (await fetch(`${base}/v1/models`)).json()) as { data: Array<{ id: string }> }).data;
      expect(data.map((entry) => entry.id)).not.toContain(FREE_MODEL_ID);
    } finally {
      await server.close();
    }
  });
});

describe('GET /v1/lane-rotation', () => {
  it('reports configured lanes a live provider list no longer serves, and skips silent providers', async () => {
    // A provider backed by a live /models list: its `old-model` lane rotated
    // to `old-model-v2` (a version bump), while `old-model-v2` serves fine.
    const live = createOpenAICompatibleProvider({
      id: 'live',
      name: 'Live',
      defaultModel: 'old-model-v2',
      baseUrl: 'http://127.0.0.1:9/v1',
      requiresKey: false,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ data: [{ id: 'old-model-v2' }, { id: 'other-model' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as typeof fetch,
    });
    const server = createModelHitchServer({
      providers: [live, mockProvider],
      defaultProviderId: 'live',
      policy: {
        trusted: [{ providerId: 'live', models: ['old-model', 'old-model-v2'] }],
        fallback: [{ providerId: 'mock', models: ['mock-model'] }],
      },
    });
    try {
      const base = (await server.listen(0, '127.0.0.1')).url;
      const res = await fetch(`${base}/v1/lane-rotation`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        rotated: Array<{ providerId: string; model: string; available: string[]; suggestion?: string }>;
        checkedAt: string;
      };
      expect(body.rotated).toEqual([
        {
          providerId: 'live',
          model: 'old-model',
          available: ['old-model-v2', 'other-model'],
          suggestion: 'old-model-v2',
        },
      ]);
      expect(body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      await server.close();
    }
  });

  it('is quiet when every provider is silent or the list still serves the lanes', async () => {
    // mockProvider has no listModels: its lane cannot be judged, so "unknown"
    // — not rotated.
    const server = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      policy: { trusted: [{ providerId: 'mock', models: ['mock-model'] }], fallback: [] },
    });
    try {
      const base = (await server.listen(0, '127.0.0.1')).url;
      const res = await fetch(`${base}/v1/lane-rotation`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rotated: unknown[]; checkedAt: string };
      expect(body.rotated).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
