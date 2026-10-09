import { afterAll, describe, expect, it } from 'vitest';
import {
  ModelHitchError,
  applyCustomLanesPlan,
  createRegistrySource,
  customLaneApiKeys,
  customLaneProviders,
  describeCustomLanesPlan,
  isCustomLanesEnabled,
  resolveCustomLanes,
  resolvePolicyLanes,
  validateConfig,
  type ModelHitchConfig,
} from '../src/index.js';
import {
  createCustomLaneProvider,
  customLaneBaseUrl,
  customLaneKeyEnvVar,
  customLaneProviderId,
  customLaneSlug,
  customLaneWire,
  isCustomLaneProviderId,
  CUSTOM_LANE_PROVIDER_PREFIX,
} from '../src/providers/custom-lane.js';
import type { ChatParams } from '../src/core/types.js';

/**
 * Custom BYOK lanes.
 *
 * These tests pin the parts that would silently misroute real traffic: the
 * provider id a lane claims, the URL and wire each schema posts to, the key
 * fallback chain, the promise that a custom lane is NEVER polled for its model
 * list, and how the lanes join the rotation (including `onLimit: 'stop'`).
 */

const ENV_NAMES = ['MODELHITCH_CUSTOM_UPSTREAM_API_KEY', 'MY_OWN_KEY'];

afterAll(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});

function baseConfig(overrides: Partial<ModelHitchConfig> = {}): ModelHitchConfig {
  return { version: 1, ...overrides };
}

const lane = {
  id: 'upstream',
  label: 'Upstream',
  baseUrl: 'https://api.upstream.test/v1',
  models: ['fast-model', 'smart-model'],
};

function capturingFetch(status = 500): {
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }>;
  impl: typeof fetch;
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    let body: unknown = {};
    try {
      body = JSON.parse(String(init?.body ?? '{}'));
    } catch {
      body = {};
    }
    const raw = init?.headers as unknown;
    const flat: Record<string, string> =
      raw && typeof (raw as { forEach?: unknown }).forEach === 'function'
        ? Object.fromEntries((raw as { entries(): Iterable<[string, string]> }).entries())
        : ((raw ?? {}) as Record<string, string>);
    calls.push({ url, method: init?.method ?? 'GET', headers: flat, body });
    return new Response('{"error":{"message":"upstream down"}}', {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, impl };
}

function params(model: string): ChatParams {
  return { model, messages: [{ role: 'user', content: 'hi' }] };
}

// ---- identity --------------------------------------------------------------

describe('custom lane identity', () => {
  it('slugs a lane id into a routable provider id', () => {
    expect(customLaneSlug('My Provider!')).toBe('my-provider');
    expect(customLaneProviderId('My Provider!')).toBe(`${CUSTOM_LANE_PROVIDER_PREFIX}my-provider`);
    expect(customLaneProviderId('', 'Fallback Label')).toBe('custom-fallback-label');
    expect(customLaneProviderId('@@@', '')).toBe('custom-lane');
    expect(isCustomLaneProviderId('custom-my-provider')).toBe(true);
    expect(isCustomLaneProviderId('opencode-byok-deepseek')).toBe(false);
    expect(isCustomLaneProviderId('openai')).toBe(false);
  });

  it('derives the env var fallback from the lane id', () => {
    expect(customLaneKeyEnvVar('upstream')).toBe('MODELHITCH_CUSTOM_UPSTREAM_API_KEY');
    expect(customLaneKeyEnvVar('My Provider!')).toBe('MODELHITCH_CUSTOM_MY_PROVIDER_API_KEY');
  });

  it('normalizes the base URL and maps each schema to a wire', () => {
    expect(customLaneBaseUrl('https://api.upstream.test/v1///')).toBe('https://api.upstream.test/v1');
    expect(customLaneWire('chat-completions')).toBe('chat-completions');
    expect(customLaneWire('responses')).toBe('responses');
    expect(customLaneWire('anthropic')).toBe('messages');
    expect(customLaneWire('google')).toBe('gemini');
    expect(customLaneWire('auto')).toBeUndefined();
    expect(customLaneWire(undefined)).toBeUndefined();
  });
});

// ---- the provider itself ---------------------------------------------------

describe('custom lane provider', () => {
  it('never polls the endpoint for models — the typed slots are the catalog', async () => {
    const provider = createCustomLaneProvider(lane, {
      fetchImpl: async () => {
        throw new Error('a custom lane must not call /models');
      },
    });
    const listed = await provider.listModels?.({});
    expect(listed?.map((m) => m.id)).toEqual(['fast-model', 'smart-model']);
    expect(provider.defaultModel).toBe('fast-model');
    expect(provider.id).toBe('custom-upstream');
    expect(provider.name).toBe('Upstream');
  });

  it('posts to the lane URL with the lane key', async () => {
    const capture = capturingFetch();
    const provider = createCustomLaneProvider({ ...lane, schema: 'chat-completions' }, { fetchImpl: capture.impl });
    await expect(provider.chat(params('fast-model'), { apiKey: 'lane-key' })).rejects.toBeInstanceOf(ModelHitchError);
    expect(capture.calls[0]?.url).toBe('https://api.upstream.test/v1/chat/completions');
    expect(capture.calls[0]?.headers.Authorization).toBe('Bearer lane-key');
    expect(capture.calls[0]?.body).toMatchObject({ model: 'fast-model' });
    // No trailing-slash duplicate and no provider prefix invented by us.
    expect(capture.calls).toHaveLength(1);
  });

  it('pins the wire when the schema says so, and detects the family on auto', async () => {
    // `auto` follows the model family: a claude-* slot is Anthropic-shaped.
    const auto = capturingFetch();
    const autoProvider = createCustomLaneProvider(
      { ...lane, models: ['claude-sonnet-4-6'], schema: 'auto' },
      { fetchImpl: auto.impl },
    );
    await expect(autoProvider.chat(params('claude-sonnet-4-6'), { apiKey: 'k' })).rejects.toBeInstanceOf(ModelHitchError);
    expect(auto.calls[0]?.url).toBe('https://api.upstream.test/v1/messages');

    // The override exists precisely because an unlisted gateway can serve a
    // claude-* model over Chat Completions.
    const pinned = capturingFetch();
    const pinnedProvider = createCustomLaneProvider(
      { ...lane, models: ['claude-sonnet-4-6'], schema: 'chat-completions' },
      { fetchImpl: pinned.impl },
    );
    await expect(pinnedProvider.chat(params('claude-sonnet-4-6'), { apiKey: 'k' })).rejects.toBeInstanceOf(ModelHitchError);
    expect(pinned.calls[0]?.url).toBe('https://api.upstream.test/v1/chat/completions');

    // Google's wire is a path template, not a plain suffix.
    const google = capturingFetch();
    const googleProvider = createCustomLaneProvider(
      { ...lane, models: ['gemini-3-flash'], schema: 'google' },
      { fetchImpl: google.impl },
    );
    await expect(googleProvider.chat(params('gemini-3-flash'), { apiKey: 'k' })).rejects.toBeInstanceOf(ModelHitchError);
    expect(google.calls[0]?.url).toBe('https://api.upstream.test/v1/models/gemini-3-flash:generateContent');
    expect(google.calls[0]?.headers['x-goog-api-key']).toBe('k');
  });

  it('names the lane when the key is missing', async () => {
    delete process.env.MODELHITCH_CUSTOM_UPSTREAM_API_KEY;
    const provider = createCustomLaneProvider({ ...lane, schema: 'chat-completions' }, { fetchImpl: capturingFetch().impl });
    await expect(provider.chat(params('fast-model'), {})).rejects.toMatchObject({
      code: 'missing-api-key',
      message: expect.stringContaining('Custom lane "Upstream" requires an API key. Set MODELHITCH_CUSTOM_UPSTREAM_API_KEY'),
    });
  });

  it('honors a lane-specific env var and a keyless endpoint', async () => {
    process.env.MY_OWN_KEY = 'env-lane-key';
    try {
      const capture = capturingFetch();
      const provider = createCustomLaneProvider(
        { ...lane, schema: 'chat-completions', apiKeyEnvVar: 'MY_OWN_KEY' },
        { fetchImpl: capture.impl },
      );
      await expect(provider.chat(params('fast-model'), {})).rejects.toBeInstanceOf(ModelHitchError);
      expect(capture.calls[0]?.headers.Authorization).toBe('Bearer env-lane-key');
    } finally {
      delete process.env.MY_OWN_KEY;
    }

    // A self-hosted gateway behind a URL needs no credential at all: the
    // request must actually go out, without an Authorization header.
    const keyless = capturingFetch();
    const keylessProvider = createCustomLaneProvider(
      { ...lane, schema: 'chat-completions', requiresKey: false },
      { fetchImpl: keyless.impl },
    );
    await expect(keylessProvider.chat(params('fast-model'), {})).rejects.toMatchObject({ code: 'provider-error' });
    expect(keyless.calls).toHaveLength(1);
    expect(keyless.calls[0]?.url).toBe('https://api.upstream.test/v1/chat/completions');
    expect(keyless.calls[0]?.headers.Authorization).toBeUndefined();

    // The same lane on a wire that resolves its own key (Anthropic messages)
    // still reports the missing credential instead of sending "Bearer undefined".
    const keylessAnthropic = capturingFetch();
    const anthropicProvider = createCustomLaneProvider(
      { ...lane, models: ['claude-sonnet-4-6'], schema: 'anthropic', requiresKey: false },
      { fetchImpl: keylessAnthropic.impl },
    );
    await expect(anthropicProvider.chat(params('claude-sonnet-4-6'), {})).rejects.toMatchObject({
      code: 'missing-api-key',
    });
    expect(keylessAnthropic.calls).toHaveLength(0);
  });
});

// ---- rotation plan ---------------------------------------------------------

describe('custom lane plan', () => {
  const config = baseConfig({
    defaultProviderId: 'vercel-ai-gateway',
    defaultModel: 'openai/gpt-5.4',
    policy: {
      trusted: [{ providerId: 'vercel-ai-gateway', models: ['openai/gpt-5.4'] }],
      fallback: [{ providerId: 'openai', models: ['gpt-5.4'] }],
    },
    customLanes: {
      enabled: true,
      lanes: [
        { id: 'upstream', label: 'Upstream', baseUrl: 'https://api.upstream.test/v1', models: ['fast-model', 'smart-model'] },
        { id: 'second', baseUrl: 'https://api.second.test/v1', models: ['other-model'] },
      ],
    },
  });

  it('leads the plan by default and makes the first lane the primary route', () => {
    const plan = applyCustomLanesPlan({
      config,
      policy: config.policy,
      defaultProviderId: config.defaultProviderId,
      defaultModel: config.defaultModel,
    });
    expect(plan.placement).toBe('lead');
    expect(plan.defaultProviderId).toBe('custom-upstream');
    expect(plan.defaultModel).toBe('fast-model');
    expect(plan.lanes.map((entry) => `${entry.providerId}/${entry.model}`)).toEqual([
      'custom-upstream/fast-model',
      'custom-upstream/smart-model',
      'custom-second/other-model',
    ]);
    // Custom lanes first, the configured buffet directly behind as the net.
    expect(plan.policy?.trusted).toEqual([
      { providerId: 'custom-upstream', models: ['fast-model', 'smart-model'] },
      { providerId: 'custom-second', models: ['other-model'] },
      { providerId: 'vercel-ai-gateway', models: ['openai/gpt-5.4'] },
    ]);
    expect(plan.policy?.fallback).toEqual([{ providerId: 'openai', models: ['gpt-5.4'] }]);
    expect(describeCustomLanesPlan(plan)).toContain('Custom lanes leading: 3 lanes');
  });

  it('appends to fallback without touching the primary route', () => {
    const fallbackConfig = baseConfig({ ...config, customLanes: { ...config.customLanes!, placement: 'fallback' } });
    const plan = applyCustomLanesPlan({
      config: fallbackConfig,
      policy: fallbackConfig.policy,
      defaultProviderId: 'vercel-ai-gateway',
      defaultModel: 'openai/gpt-5.4',
    });
    expect(plan.placement).toBe('fallback');
    // The buffet stays primary: the user's configured route is not displaced.
    expect(plan.defaultProviderId).toBe('vercel-ai-gateway');
    expect(plan.defaultModel).toBe('openai/gpt-5.4');
    expect(plan.policy?.trusted).toEqual([{ providerId: 'vercel-ai-gateway', models: ['openai/gpt-5.4'] }]);
    expect(plan.policy?.fallback).toEqual([
      { providerId: 'openai', models: ['gpt-5.4'] },
      { providerId: 'custom-upstream', models: ['fast-model', 'smart-model'] },
      { providerId: 'custom-second', models: ['other-model'] },
    ]);
    expect(describeCustomLanesPlan(plan)).toContain('Custom lanes as fallback');
  });

  it('marks stop-on-limit lanes terminal so the walk knows where to stop', () => {
    const stopping = baseConfig({
      ...config,
      customLanes: {
        enabled: true,
        lanes: [{ id: 'metered', baseUrl: 'https://api.metered.test/v1', models: ['m'], onLimit: 'stop' }],
      },
    });
    const plan = applyCustomLanesPlan({ config: stopping, policy: stopping.policy });
    expect(plan.stopping).toEqual(['custom-metered']);
    expect(plan.policy?.trusted[0]).toEqual({ providerId: 'custom-metered', models: ['m'], terminal: true });

    // …and the terminator survives policy resolution into the walked targets.
    const source = createRegistrySource(customLaneProviders(stopping));
    const targets = resolvePolicyLanes(plan.policy!, { providerId: 'custom-metered', model: 'm' }, source);
    expect(targets.find((t) => t.providerId === 'custom-metered')?.terminal).toBe(true);

    // A rotate lane carries no terminator at all.
    const rotating = applyCustomLanesPlan({ config, policy: config.policy });
    expect(rotating.policy?.trusted[0]).not.toHaveProperty('terminal');
  });

  it('leaves routing untouched when the block is off or has no usable lane', () => {
    const off = baseConfig({ policy: config.policy, customLanes: { enabled: false, lanes: config.customLanes!.lanes } });
    const plan = applyCustomLanesPlan({ config: off, policy: off.policy, defaultProviderId: 'vercel-ai-gateway' });
    expect(plan.lanes).toEqual([]);
    expect(plan.policy).toBe(off.policy);
    expect(plan.defaultProviderId).toBe('vercel-ai-gateway');
    expect(describeCustomLanesPlan(plan)).toBeUndefined();

    const empty = baseConfig({ customLanes: { enabled: true, lanes: [] } });
    expect(applyCustomLanesPlan({ config: empty }).lanes).toEqual([]);

    // A lane that is missing its endpoint or its slots cannot be served, so it
    // never reaches the plan.
    const incomplete = baseConfig({
      customLanes: {
        enabled: true,
        lanes: [
          { id: 'no-url', baseUrl: '', models: ['m'] },
          { id: 'no-models', baseUrl: 'https://api.x.test/v1', models: [] },
        ],
      },
    });
    expect(applyCustomLanesPlan({ config: incomplete }).lanes).toEqual([]);
  });

  it('skips disabled lanes and keeps their provider out of the set', () => {
    const config2 = baseConfig({
      customLanes: {
        enabled: true,
        lanes: [
          { id: 'a', baseUrl: 'https://api.a.test/v1', models: ['m1'] },
          { id: 'b', baseUrl: 'https://api.b.test/v1', models: ['m2'], enabled: false },
        ],
      },
    });
    expect(resolveCustomLanes(config2).map((l) => l.providerId)).toEqual(['custom-a']);
    expect(customLaneProviders(config2).map((p) => p.id)).toEqual(['custom-a']);
    expect(isCustomLanesEnabled(config2)).toBe(true);
    expect(isCustomLanesEnabled(baseConfig({ customLanes: { enabled: false, lanes: [{ id: 'a', baseUrl: 'https://api.a.test/v1', models: ['m1'] }] } }))).toBe(false);
  });

  it('de-duplicates typed slots', () => {
    const dupes = baseConfig({
      customLanes: {
        enabled: true,
        lanes: [{ id: 'a', baseUrl: 'https://api.a.test/v1', models: ['m1', ' m1 ', 'm2', '  '] }],
      },
    });
    expect(resolveCustomLanes(dupes)[0]?.models).toEqual(['m1', 'm2']);
  });
});

// ---- credentials -----------------------------------------------------------

describe('custom lane credentials', () => {
  const byok: ModelHitchConfig = baseConfig({
    customLanes: {
      enabled: true,
      lanes: [
        { id: 'stored', baseUrl: 'https://api.a.test/v1', models: ['m'] },
        { id: 'from-env', baseUrl: 'https://api.b.test/v1', models: ['m'] },
      ],
    },
  });

  it('reads the key stored beside every other provider key', () => {
    expect(customLaneApiKeys(baseConfig({ ...byok, keys: { 'custom-stored': 'stored-key' } }))).toEqual({
      'custom-stored': 'stored-key',
    });
  });

  it('falls back to the lane env var, so a key can stay out of the config', () => {
    process.env.MODELHITCH_CUSTOM_FROM_ENV_API_KEY = 'env-key';
    try {
      expect(customLaneApiKeys(byok)).toEqual({ 'custom-from-env': 'env-key' });
      // A stored key wins over the env for the same lane.
      expect(customLaneApiKeys(baseConfig({ ...byok, keys: { 'custom-from-env': 'stored' } }))).toEqual({
        'custom-from-env': 'stored',
      });
    } finally {
      delete process.env.MODELHITCH_CUSTOM_FROM_ENV_API_KEY;
    }
  });
});

// ---- config validation -----------------------------------------------------

describe('customLanes config validation', () => {
  it('accepts a complete block', () => {
    const result = validateConfig({
      version: 1,
      customLanes: {
        enabled: true,
        placement: 'lead',
        lanes: [
          {
            id: 'upstream',
            label: 'Upstream',
            baseUrl: 'https://api.upstream.test/v1',
            schema: 'chat-completions',
            models: ['fast-model'],
            onLimit: 'stop',
            headers: { 'x-org': 'acme' },
          },
        ],
      },
    });
    expect(result.errors).toEqual([]);
  });

  it('rejects the shapes that would fail at request time', () => {
    const bad = validateConfig({
      version: 1,
      customLanes: {
        enabled: true,
        placement: 'sideways',
        lanes: [
          { id: '', baseUrl: 'api.example.com', models: [] },
          { id: 'urlcheck', baseUrl: 'api.example.com', models: ['m'] },
          { id: 'nils', baseUrl: 'https://api.nils.test/v1', models: [] },
          { id: 'dup', label: 'Dup', baseUrl: 'https://api.a.test/v1', models: ['m'], schema: 'nope', onLimit: 'hold' },
          { id: 'dup', label: 'Dup', baseUrl: 'https://api.a.test/v1', models: ['m'] },
        ],
      },
    });
    const joined = bad.errors.join('\n');
    expect(joined).toMatch(/placement must be "lead" or "fallback"/);
    expect(joined).toMatch(/\.id must be a non-empty lane id/);
    expect(joined).toMatch(/must start with http:\/\/ or https:\/\//);
    expect(joined).toMatch(/models must list at least one model id/);
    expect(joined).toMatch(/schema must be one of/);
    expect(joined).toMatch(/onLimit must be "rotate" or "stop"/);
    expect(joined).toMatch(/collides with another lane/);
    expect(validateConfig({ version: 1, customLanes: 'nope' }).errors.join('\n')).toMatch(/customLanes must be an object/);
    expect(validateConfig({ version: 1, customLanes: { enabled: true, lanes: [{ id: 'a', baseUrl: 'https://a.test', models: ['m'], headers: { x: 1 } }] } }).errors.join('\n')).toMatch(/headers values must be strings/);
  });

  it('warns when a stop lane hides the lanes behind it', () => {
    const result = validateConfig({
      version: 1,
      customLanes: {
        enabled: true,
        lanes: [
          { id: 'metered', baseUrl: 'https://api.metered.test/v1', models: ['m'], onLimit: 'stop' },
          { id: 'behind', baseUrl: 'https://api.behind.test/v1', models: ['m2'] },
        ],
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toMatch(/lane "metered" is onLimit:"stop" but 1 lane\(s\) follow it/);
  });

  it('warns when the block is on but nothing is servable', () => {
    const result = validateConfig({ version: 1, customLanes: { enabled: true, lanes: [] } });
    expect(result.warnings.join('\n')).toMatch(/no lane is complete/);
  });
});
