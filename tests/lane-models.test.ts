import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModelHitchServer,
  createOpenAICompatibleProvider,
  mockProvider,
  type OpenAICompatibleServer,
  type Policy,
} from '../src/index.js';

/**
 * Bridge lanes in `GET /v1/models`.
 *
 * A custom-endpoint client (VS Code "Add model", Cline, Cursor, Codex
 * `model_providers`) builds its picker from this list alone, so the lanes the
 * user configured have to be in it — in plan order, with the id a client can
 * send straight back.
 */

/** A second lane on its own provider, so ordering and qualification are visible. */
const laneTwo = createOpenAICompatibleProvider({
  id: 'lane-two',
  name: 'Lane Two',
  defaultModel: 'two-model',
  baseUrl: 'http://127.0.0.1:9/v1', // never called in these tests
  requiresKey: false,
});

const policy: Policy = {
  trusted: [{ providerId: 'mock', models: ['mock-model'] }],
  fallback: [{ providerId: 'lane-two', models: ['two-model'] }],
};

async function startServer(options: Parameters<typeof createModelHitchServer>[0]): Promise<{
  server: OpenAICompatibleServer;
  base: string;
}> {
  const server = createModelHitchServer(options);
  const info = await server.listen(0, '127.0.0.1');
  return { server, base: info.url };
}

type ModelEntry = {
  id: string;
  owned_by: string;
  name?: string;
  modelhitch?: { tier: string; laneIndex: number; providerId: string; model: string; terminal: boolean };
};

describe('GET /v1/models with a plan (policy)', () => {
  let server: OpenAICompatibleServer;
  let base: string;

  beforeAll(async () => {
    ({ server, base } = await startServer({
      providers: [mockProvider, laneTwo],
      defaultProviderId: 'mock',
      policy,
      staticModels: { mock: ['extra-model'] },
    }));
  });

  afterAll(async () => {
    await server.close();
  });

  async function models(): Promise<ModelEntry[]> {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: ModelEntry[] }).data;
  }

  it('publishes the trusted lane, then the fallback lane, ahead of the catalog', async () => {
    const data = await models();
    expect(data.slice(0, 2).map((entry) => entry.id)).toEqual(['mock-model', 'lane-two/two-model']);
    expect(data.slice(2).map((entry) => entry.id)).toEqual(['extra-model']);
  });

  it('publishes a lane on the default provider under the bare id the catalog already uses', async () => {
    const data = await models();
    // Bare is the lane here: the default provider owns the id, and using it
    // collapses the plan entry with the catalog entry instead of listing the
    // same lane twice.
    expect(data.filter((entry) => entry.id === 'mock-model')).toHaveLength(1);
    expect(data.filter((entry) => entry.id === 'mock/mock-model')).toHaveLength(0);
  });

  it('qualifies a lane whose provider is not the default, so the id names the lane', async () => {
    const lane = (await models()).find((entry) => entry.id === 'lane-two/two-model');
    expect(lane?.owned_by).toBe('lane-two');
  });

  it('names the lane with its model, provider, and tier', async () => {
    const data = await models();
    expect(data[0]?.name).toBe('Mock Model · Mock (deterministic) · trusted lane 1');
    expect(data[1]?.name).toBe('Two Model · Lane Two · fallback lane 1');
  });

  it('carries lane metadata a picker can group by', async () => {
    const data = await models();
    expect(data[0]?.modelhitch).toEqual({
      id: 'mock-model',
      providerId: 'mock',
      model: 'mock-model',
      tier: 'trusted',
      laneIndex: 1,
      terminal: false,
      name: 'Mock Model · Mock (deterministic) · trusted lane 1',
    });
    expect(data[1]?.modelhitch).toMatchObject({ tier: 'fallback', laneIndex: 1 });
  });

  it('lists a lane even when its provider is never polled for models', async () => {
    // The mock provider has no listModels at all: the lane list is the plan's,
    // not discovery's.
    const ids = (await models()).map((entry) => entry.id);
    expect(ids).toContain('lane-two/two-model');
  });

  it('describes a lane once, and only the plan carries lane metadata', async () => {
    const data = await models();
    expect(data.filter((entry) => entry.id === 'mock-model')).toHaveLength(1);
    expect(data.filter((entry) => !entry.modelhitch).map((entry) => entry.id)).toEqual(['extra-model']);
  });

  it('answers GET /v1/models/:id for a lane id', async () => {
    const res = await fetch(`${base}/v1/models/mock-model`);
    expect(res.status).toBe(200);
    const entry = (await res.json()) as ModelEntry;
    expect(entry.id).toBe('mock-model');
    expect(entry.modelhitch?.tier).toBe('trusted');
  });

  it('routes the id the picker published, and the fully qualified form of it', async () => {
    for (const model of ['mock-model', 'mock/mock-model']) {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]?.message.content).toContain('Mock reply');
    }
  });
});

describe('GET /v1/models when a bare lane id would be shadowed', () => {
  it('keeps the lane qualified rather than publishing a route that points elsewhere', async () => {
    // `gateway` is the default provider and its lane model contains a slash,
    // so a bare id would be matched against the `openai` provider prefix first
    // and reach the wrong lane.
    const gateway = createOpenAICompatibleProvider({
      id: 'gateway',
      name: 'Gateway',
      defaultModel: 'openai/gpt-5.4',
      baseUrl: 'http://127.0.0.1:9/v1',
      requiresKey: false,
    });
    const openai = createOpenAICompatibleProvider({
      id: 'openai',
      name: 'OpenAI',
      defaultModel: 'gpt-5.4',
      baseUrl: 'http://127.0.0.1:9/v1',
      requiresKey: false,
    });
    const { server, base } = await startServer({
      providers: [gateway, openai],
      defaultProviderId: 'gateway',
      policy: { trusted: [{ providerId: 'gateway', models: ['openai/gpt-5.4'] }], fallback: [] },
    });
    try {
      const data = ((await (await fetch(`${base}/v1/models`)).json()) as { data: ModelEntry[] }).data;
      const lane = data.find((entry) => entry.modelhitch);
      expect(lane?.id).toBe('gateway/openai/gpt-5.4');
      // The catalog's own bare entry is left alone — the plan does not claim it.
      expect(data.find((entry) => entry.id === 'openai/gpt-5.4')?.modelhitch).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('GET /v1/models without a plan', () => {
  it('publishes no lane entries when the bridge has neither a policy nor auto-mode', async () => {
    const { server, base } = await startServer({ providers: [mockProvider, laneTwo], defaultProviderId: 'mock' });
    try {
      const data = ((await (await fetch(`${base}/v1/models`)).json()) as { data: ModelEntry[] }).data;
      expect(data.some((entry) => entry.modelhitch)).toBe(false);
      expect(data.some((entry) => entry.name !== undefined)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('still lists models when no provider is registered at all', async () => {
    const { server, base } = await startServer({ providers: [] });
    try {
      const res = await fetch(`${base}/v1/models`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: ModelEntry[] }).data).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe('GET /v1/models with auto-mode', () => {
  it('publishes the primary lane, then the rotation', async () => {
    const { server, base } = await startServer({
      providers: [mockProvider, laneTwo],
      defaultProviderId: 'mock',
      autoMode: { lanes: [{ providerId: 'lane-two', model: 'two-model' }] },
    });
    try {
      const data = ((await (await fetch(`${base}/v1/models`)).json()) as { data: ModelEntry[] }).data;
      expect(data.slice(0, 2).map((entry) => entry.id)).toEqual(['mock-model', 'lane-two/two-model']);
      expect(data[0]?.modelhitch).toMatchObject({ tier: 'primary', laneIndex: 1 });
      expect(data[1]?.modelhitch).toMatchObject({ tier: 'fallback', laneIndex: 1 });
    } finally {
      await server.close();
    }
  });
});
