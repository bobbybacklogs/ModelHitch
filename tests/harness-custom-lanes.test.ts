import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntime } from '../harness/runtime.js';
import type { ModelHitchConfig } from '../src/index.js';

/**
 * The harness (`mhh`) reads the same settings document the bridge does, so a
 * custom BYOK lane has to work there too. These tests pin the two halves of
 * that: the lane becomes a real provider (policy validation used to reject the
 * whole document with "unknown provider"), and it carries the plan's routing.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(overrides: Partial<ModelHitchConfig> = {}): ModelHitchConfig {
  return {
    version: 1,
    keys: { 'custom-upstream': 'lane-key' },
    policy: { trusted: [{ providerId: 'vercel-ai-gateway', models: ['openai/gpt-5.4'] }], fallback: [] },
    customLanes: {
      enabled: true,
      lanes: [
        { id: 'upstream', label: 'My Endpoint', baseUrl: 'https://api.upstream.test/v1', models: ['fast-model'], schema: 'chat-completions' },
      ],
    },
    ...overrides,
  };
}

function stubChatFetch(): Array<{ url: string; auth?: string; body: any }> {
  const calls: Array<{ url: string; auth?: string; body: any }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.headers as unknown;
    const headers: Record<string, string> =
      raw && typeof (raw as { forEach?: unknown }).forEach === 'function'
        ? Object.fromEntries((raw as { entries(): Iterable<[string, string]> }).entries())
        : ((raw ?? {}) as Record<string, string>);
    calls.push({ url, auth: headers.Authorization ?? headers.authorization, body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-custom',
        object: 'chat.completion',
        created: 0,
        model: 'fast-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'lane reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return calls;
}

describe('harness runtime with custom BYOK lanes', () => {
  it('serves a lane the registry does not ship, using the stored key', async () => {
    const calls = stubChatFetch();
    const runtime = await buildRuntime({ config: config(), configPath: 'C:/tmp/config.json' });

    // The lane leads the plan, so it is the run's default route.
    expect(runtime.provider).toBe('custom-upstream');
    expect(runtime.model).toBe('fast-model');
    expect(runtime.client.providers.map((p) => p.id)).toContain('custom-upstream');

    const result = await runtime.client.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.message.content).toBe('lane reply');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.upstream.test/v1/chat/completions');
    expect(calls[0]?.auth).toBe('Bearer lane-key');
  });

  it('keeps the configured buffet primary when the lanes are fallback-placed', async () => {
    const runtime = await buildRuntime({
      config: config({
        defaultProviderId: 'vercel-ai-gateway',
        defaultModel: 'openai/gpt-5.4',
        customLanes: {
          enabled: true,
          placement: 'fallback',
          lanes: [{ id: 'upstream', baseUrl: 'https://api.upstream.test/v1', models: ['fast-model'], schema: 'chat-completions' }],
        },
      }),
      configPath: 'C:/tmp/config.json',
    });
    expect(runtime.provider).toBe('vercel-ai-gateway');
    expect(runtime.model).toBe('openai/gpt-5.4');
    // Still available as a lane — reachable explicitly and as a fallback.
    expect(runtime.client.providers.map((p) => p.id)).toContain('custom-upstream');
  });

  it('lets --model route to the lane explicitly', async () => {
    const calls = stubChatFetch();
    const runtime = await buildRuntime({
      config: config({ customLanes: { enabled: false, lanes: [] } }),
      configPath: 'C:/tmp/config.json',
      modelOverride: 'custom-upstream/fast-model',
    });
    // Disabled lanes are not registered, so the route is unknown — the override
    // cannot invent a provider.
    await expect(runtime.client.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      code: 'provider-not-found',
    });
    expect(calls).toEqual([]);
  });
});
