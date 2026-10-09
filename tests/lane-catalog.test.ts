import { describe, expect, it } from 'vitest';
import {
  createRegistrySource,
  displayModelName,
  laneLabel,
  laneRoute,
  planLanes,
  planModelEntries,
  providerDisplayName,
  resolvePolicyLanes,
  type FailoverTarget,
  type Policy,
  type Provider,
} from '../src/index.js';

/**
 * The plan published as models.
 *
 * `GET /v1/models` is what a custom-endpoint picker (VS Code, Cline, Cursor,
 * Codex) renders, so these tests pin the projection: which lanes appear, in
 * what order, what id a client sends back, and how a lane is labelled.
 */

function fakeProvider(id: string, defaultModel: string): Provider {
  return {
    id,
    name: `${id} name`,
    defaultModel,
    capabilities: { streaming: true, toolCalling: true, vision: true, embeddings: false },
    chat: async () => ({ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }),
    stream: async function* () {
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
}

const providers = [fakeProvider('alpha', 'a-model'), fakeProvider('beta', 'b-model')];
const source = createRegistrySource(providers);
const defaultModelFor = (providerId: string): string | undefined => source.defaultModel(providerId);

const policy: Policy = {
  trusted: [
    { providerId: 'alpha', models: ['a-model'] },
    { providerId: 'beta', models: ['b-model'] },
  ],
  fallback: [{ providerId: 'alpha', models: ['a-cheap', 'a-cheaper'] }],
};

describe('planLanes', () => {
  it('expands trusted then fallback with tiers and 1-based lane indexes', () => {
    const lanes = planLanes({ policy, defaultModelFor });
    expect(lanes.map((lane) => `${lane.tier}:${lane.laneIndex}:${lane.providerId}/${lane.model}`)).toEqual([
      'trusted:1:alpha/a-model',
      'trusted:2:beta/b-model',
      'fallback:1:alpha/a-cheap',
      'fallback:2:alpha/a-cheaper',
    ]);
  });

  it('falls back to the provider default model when an entry names no models', () => {
    const lanes = planLanes({ policy: { trusted: [{ providerId: 'alpha' }], fallback: [] }, defaultModelFor });
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ providerId: 'alpha', model: 'a-model', tier: 'trusted', laneIndex: 1 });
  });

  it('drops an entry that names no models when the provider is unreachable', () => {
    // Nothing to name the lane with. An entry WITH models is still expanded —
    // whether the bridge can serve the provider is the server's call, because
    // only it knows the runtime provider list.
    const lanes = planLanes({ policy: { trusted: [{ providerId: 'missing' }], fallback: [] }, defaultModelFor });
    expect(lanes).toHaveLength(0);
  });

  it('lists a lane once when it sits in both trusted and fallback, and keeps indexes contiguous', () => {
    const lanes = planLanes({
      policy: {
        trusted: [{ providerId: 'alpha', models: ['a-model'] }],
        fallback: [{ providerId: 'alpha', models: ['a-model', 'a-cheap'] }],
      },
      defaultModelFor,
    });
    expect(lanes.map((lane) => `${lane.tier}:${lane.laneIndex}:${lane.model}`)).toEqual([
      'trusted:1:a-model',
      'fallback:1:a-cheap',
    ]);
  });

  it('carries stop-on-limit through to the lane', () => {
    const lanes = planLanes({
      policy: { trusted: [{ providerId: 'alpha', models: ['a-model'], terminal: true }], fallback: [] },
      defaultModelFor,
    });
    expect(lanes[0]?.terminal).toBe(true);
  });

  it('matches resolvePolicyLanes order, so the catalog cannot drift from the router', () => {
    const primary: FailoverTarget = { providerId: 'elsewhere', model: 'other-model' };
    const routed = resolvePolicyLanes(policy, primary, source).slice(1);
    expect(planLanes({ policy, defaultModelFor }).map((lane) => `${lane.providerId}/${lane.model}`)).toEqual(
      routed.map((target) => `${target.providerId}/${target.model}`),
    );
  });

  it('describes the auto-mode plan as a primary lane plus the rotation', () => {
    const lanes = planLanes({
      autoMode: { lanes: [{ providerId: 'beta', model: 'b-model' }] },
      primary: { providerId: 'alpha', model: 'a-model' },
    });
    expect(lanes.map((lane) => `${lane.tier}:${lane.laneIndex}:${lane.providerId}/${lane.model}`)).toEqual([
      'primary:1:alpha/a-model',
      'fallback:1:beta/b-model',
    ]);
  });

  it('publishes nothing when the bridge has no plan at all', () => {
    expect(planLanes({ defaultModelFor })).toEqual([]);
    expect(planLanes({ autoMode: true, defaultModelFor })).toEqual([]); // no primary lane to start from
  });
});

describe('planModelEntries', () => {
  it('publishes the real qualified route, never an alias', () => {
    const entries = planModelEntries(planLanes({ policy, defaultModelFor }));
    expect(entries.map((entry) => entry.id)).toEqual([
      'alpha/a-model',
      'beta/b-model',
      'alpha/a-cheap',
      'alpha/a-cheaper',
    ]);
  });

  it('names the model, the provider, and where the lane sits', () => {
    const entries = planModelEntries(planLanes({ policy, defaultModelFor }), {
      providerName: (id) => providers.find((provider) => provider.id === id)?.name,
    });
    expect(entries[0]?.name).toBe('A Model · alpha name · trusted lane 1');
    expect(entries[2]?.name).toBe('A Cheap · alpha name · fallback lane 1');
  });

  it('flags a terminal lane in the label', () => {
    const entries = planModelEntries(
      planLanes({
        policy: { trusted: [{ providerId: 'alpha', models: ['a-model'], terminal: true }], fallback: [] },
        defaultModelFor,
      }),
      { providerName: () => 'Alpha' },
    );
    expect(entries[0]?.name).toBe('A Model · Alpha · trusted lane 1 · stop on limit');
    expect(entries[0]?.terminal).toBe(true);
  });

  it('lets the caller choose the published route', () => {
    // The bridge publishes the default provider's lanes bare, so they collapse
    // with the ids the catalog already advertises.
    const entries = planModelEntries(planLanes({ policy, defaultModelFor }), {
      routeFor: (lane) => (lane.providerId === 'alpha' ? lane.model : laneRoute(lane)),
    });
    expect(entries.map((entry) => entry.id)).toEqual(['a-model', 'beta/b-model', 'a-cheap', 'a-cheaper']);
    // The lane record still names its own provider and model.
    expect(entries[0]).toMatchObject({ providerId: 'alpha', model: 'a-model' });
  });

  it('maps a lane to the route a client sends back', () => {
    expect(laneRoute({ providerId: 'opencode-go', model: 'deepseek-v4-pro' })).toBe(
      'opencode-go/deepseek-v4-pro',
    );
  });
});

describe('labels', () => {
  it('reads a model id as a name, keeping version dots and namespaces', () => {
    expect(displayModelName('deepseek-v4-flash')).toBe('DeepSeek V4 Flash');
    expect(displayModelName('claude-sonnet-4.5')).toBe('Claude Sonnet 4.5');
    expect(displayModelName('openai/gpt-5.4', 'vercel-ai-gateway')).toBe('OpenAI / GPT 5.4');
    expect(displayModelName('gemini-3.5-flash-lite')).toBe('Gemini 3.5 Flash Lite');
    expect(displayModelName('meta-llama/llama-3.1-8b-instruct:free', 'openrouter')).toBe(
      'Meta Llama / Llama 3.1 8b Instruct',
    );
  });

  it('prefers the provider name the bridge knows, else spells the id out', () => {
    expect(providerDisplayName('opencode-go', 'OpenCode Go')).toBe('OpenCode Go');
    expect(providerDisplayName('vercel-ai-gateway')).toBe('Vercel AI Gateway');
    expect(providerDisplayName('custom_upstream')).toBe('Custom Upstream');
  });

  it('labels a lane from its parts alone', () => {
    expect(laneLabel({ providerId: 'beta', model: 'b-model', tier: 'fallback', laneIndex: 2 })).toBe(
      'B Model · Beta · fallback lane 2',
    );
  });
});
