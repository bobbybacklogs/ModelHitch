import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION,
  CircuitBreaker,
  MemoryLaneCooldown,
  createModelHitchServer,
  createRegistrySource,
  defaultConfigTemplate,
  defaultProviders,
  isMaskedSecret,
  maskSecret,
  resolvePolicyLanes,
  serializeConfig,
  validateConfig,
  buildCatalogOptions,
  buildCooldownFromConfig,
  type ModelHitchConfig,
  type OpenAICompatibleServer,
} from '../src/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfigFile, writeConfigFile } from '../src/config-file.js';
import { settingsPageHtml } from '../src/settings-page.js';

// ---- pure config helpers ---------------------------------------------------

describe('config validity + serialization', () => {
  it('accepts a valid full config', () => {
    const cfg: ModelHitchConfig = {
      version: CONFIG_VERSION,
      defaultProviderId: 'openai',
      policy: {
        trusted: [{ providerId: 'openai', models: ['gpt-5.5'] }],
        fallback: [{ providerId: 'anthropic' }],
        maxProviders: 2,
        backoff: { type: 'exponential', baseMs: 500, maxMs: 10_000 },
      },
      catalog: { providers: ['openai', 'anthropic'], baseUrls: { perplexity: 'https://api.perplexity.ai/v1' }, ttlMs: 3_600_000 },
      cooldown: { type: 'circuit-breaker', failureThreshold: 5, baseTripMs: 20_000, maxTripMs: 60_000 },
      keys: { openai: 'sk-secret-openai', anthropic: 'sk-ant-secret' },
    };
    expect(validateConfig(cfg).errors).toEqual([]);
  });

  it('rejects bad shapes', () => {
    expect(validateConfig(null).errors.length).toBeGreaterThan(0);
    expect(validateConfig({ version: 99 }).errors.join('\n')).toMatch(/version/);
    expect(validateConfig({ policy: { trusted: [], fallback: [] } }).errors.join('\n')).toMatch(/at least one/);
    expect(validateConfig({ cooldown: { type: 'nope' } }).errors.join('\n')).toMatch(/cooldown/);
    expect(validateConfig({ cooldown: { type: 'circuit-breaker', maxTripMs: 1, baseTripMs: 100 } }).errors.join('\n')).toMatch(/maxTripMs/);
    expect(validateConfig({ catalog: { providers: 'openai' } }).errors.join('\n')).toMatch(/array/);
    expect(validateConfig({ keys: 'sk-foo' }).errors.join('\n')).toMatch(/object/);
  });

  it('image generation is disabled by default and validates when enabled', () => {
    const tpl = defaultConfigTemplate();
    expect(tpl.imageGeneration).toMatchObject({ enabled: false, providerId: 'openai', model: 'gpt-image-2' });
    expect(validateConfig({ version: 1, imageGeneration: { enabled: true, providerId: 'openai', model: 'gpt-image-2', quality: 'low' } }).errors).toEqual([]);
    expect(validateConfig({ version: 1, imageGeneration: { enabled: true, providerId: 'openai', model: 'gpt-image-1.5', quality: 'low' } }).errors.join('\n')).toMatch(/medium quality/);
    expect(validateConfig({ version: 1, imageGeneration: { enabled: true, providerId: 'huggingface' } }).errors.join('\n')).toMatch(/providerId/);
    expect(validateConfig({ version: 1, imageGeneration: { enabled: true, providerId: 'unknown' } }).errors.join('\n')).toMatch(/providerId/);
  });

  it('maskSecret + serializeConfig hide plaintext keys', () => {
    expect(maskSecret('sk-abc123')).toBe('••••••c123');
    expect(maskSecret('short')).toBe('••••••hort'); // 5 chars: bullets + last 4
    expect(maskSecret('abcd')).toBe('••••'); // <=4: fully masked
    const masked = serializeConfig({ version: 1, keys: { openai: 'sk-abcdef' } }, { maskSecrets: true });
    expect(masked.keys?.openai).toBe('••••••cdef');
    expect((masked as { _masked?: true })._masked).toBe(true);
  });

  it('isMaskedSecret detects placeholders so a masked blob is never persisted back (F1)', () => {
    expect(isMaskedSecret(maskSecret('sk-abcdef'))).toBe(true);
    expect(isMaskedSecret('sk-real-plaintext')).toBe(false);
    expect(isMaskedSecret('')).toBe(false);
  });

  it('buildCooldownFromConfig + buildCatalogOptions construct the right engines', () => {
    expect(buildCooldownFromConfig({ cooldown: { type: 'circuit-breaker' } })).toBeInstanceOf(CircuitBreaker);
    expect(buildCooldownFromConfig({ cooldown: { type: 'memory' } })).toBeInstanceOf(MemoryLaneCooldown);
    expect(buildCooldownFromConfig({})).toBeUndefined();
    const cat = buildCatalogOptions({ catalog: { providers: ['a'], baseUrls: { b: 'x' }, ttlMs: 5 } });
    expect(cat?.allow).toEqual(['a']);
    expect(cat?.baseUrls).toEqual({ b: 'x' });
    expect(cat?.ttlMs).toBe(5);
  });

  it('defaultConfigTemplate is valid and round-trips through the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-test-'));
    const path = join(dir, 'config.json');
    try {
      writeConfigFile(path, defaultConfigTemplate());
      const read = readConfigFile(path);
      expect(read?.version).toBe(CONFIG_VERSION);
      expect(validateConfig(defaultConfigTemplate()).errors).toEqual([]);
      // Free-model safety net must be present; a hard maxProviders cap would
      // trim cross-provider rotation when the request primary is a third id.
      const tpl = defaultConfigTemplate();
      expect(tpl.policy?.maxProviders).toBeUndefined();
      const fallbackModels = (tpl.policy?.fallback ?? []).flatMap((e) => e.models ?? []);
      expect(fallbackModels).toContain('anthropic/claude-sonnet-4.6');
      expect(fallbackModels).toContain('google/gemini-3-flash');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default policy keeps gateway fallbacks when the request primary is a third provider', () => {
    // Regression: maxProviders used to trim safety-net lanes for third-party primaries.
    const policy = defaultConfigTemplate().policy!;
    const source = createRegistrySource(defaultProviders);
    const targets = resolvePolicyLanes(policy, { providerId: 'openai', model: 'gpt-4o-mini' }, source);
    expect(targets.map((t) => `${t.providerId}/${t.model}`)).toEqual([
      'openai/gpt-4o-mini',
      'vercel-ai-gateway/openai/gpt-5.4',
      'vercel-ai-gateway/anthropic/claude-sonnet-4.6',
      'vercel-ai-gateway/google/gemini-3-flash',
      'openai/gpt-5.4',
    ]);
  });

  it('readConfigFile returns null when missing and throws on invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mh-test-'));
    const path = join(dir, 'config.json');
    try {
      expect(readConfigFile(path)).toBeNull();
      writeFileSync(path, '{ not json', 'utf8');
      expect(() => readConfigFile(path)).toThrow(/not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- settings bridge endpoints ---------------------------------------------

describe('settings bridge endpoints', () => {
  let server: OpenAICompatibleServer;
  let base: string;
  let configured: ModelHitchConfig;

  beforeAll(async () => {
    configured = {
      version: 1,
      defaultProviderId: 'mock',
      policy: { trusted: [{ providerId: 'mock', models: ['mock-model'] }], fallback: [], maxProviders: 1 },
      cooldown: { type: 'circuit-breaker' },
      keys: { mock: 'sk-mock-secret' },
    };
    let persisted = 0;
    let applied: ModelHitchConfig | null = null;
    server = createModelHitchServer({
      defaultProviderId: 'mock',
      policy: configured.policy,
      cooldown: buildCooldownFromConfig(configured),
      configBridge: {
        getConfig: () => serializeConfig(configured, { maskSecrets: true }),
        updateConfig: async (next: unknown) => {
          const v = validateConfig(next as ModelHitchConfig);
          if (v.errors.length) return { ok: false, errors: v.errors };
          configured = next as ModelHitchConfig;
          applied = configured;
          persisted++;
          return { ok: true };
        },
      },
    });

    const info = await server.listen(0, '127.0.0.1');
    base = info.url;
    // A tiny var for later assertions isn't spied — use closures.
    void applied;
    void persisted;
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves the settings HTML page', async () => {
    const res = await fetch(`${base}/settings`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('model');
    expect(html).toContain('Lane health');
  });

  it("serves an inline script that actually parses (template escape-rot guard)", () => {
    // Regression: the page is one big template literal. A bare `\n` or `<\/x>`
    // inside it gets consumed at build time, injecting a literal newline /
    // broken regex into the served JS — which kills the whole script (dead
    // key inputs, dead search, no config rendering) while the static HTML
    // still looks fine.
    const html = settingsPageHtml();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).toBeTruthy();
    expect(() => new Function(match![1]!)).not.toThrow();
    // The two known escape sites must reach the browser verbatim.
    expect(html).toContain("errs.join('\\n')");
    expect(html).toContain('<\\/select>');
  });

  it('GET /v1/config returns the masked document', async () => {
    const res = await fetch(`${base}/v1/config`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toMatchObject({ version: 1, defaultProviderId: 'mock' });
    expect((doc as { keys: Record<string, string> }).keys?.mock).toContain('••••');
    expect((doc as { keys: Record<string, string> }).keys?.mock).not.toContain('sk-mock-secret');
  });

  it('POST /v1/images/generations is blocked while the image lane is off', async () => {
    const server = createModelHitchServer({
      defaultProviderId: 'mock',
      configBridge: {
        getConfig: () => serializeConfig(defaultConfigTemplate(), { maskSecrets: true }),
        updateConfig: async () => ({ ok: true }),
      },
    });
    const info = await server.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${info.url}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-1', prompt: 'A minimal icon' }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.message).toMatch(/image lane/i);
    } finally {
      await server.close();
    }
  });

  it('POST /v1/images/generations maps the verified OpenAI Image API contract', async () => {
    let upstreamUrl = '';
    let upstreamBody: Record<string, unknown> = {};
    const imageServer = createModelHitchServer({
      providers: defaultProviders,
      apiKeys: { openai: 'sk-test' },
      imageGeneration: { enabled: true, providerId: 'openai', model: 'gpt-image-2', quality: 'low', size: '1024x1024' },
      imageFetch: async (input, init) => {
        upstreamUrl = String(input);
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ data: [{ b64_json: 'openai-image' }] }), { status: 200 });
      },
    });
    const info = await imageServer.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${info.url}/v1/images/generations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'A minimal icon' }),
      });
      expect(res.status).toBe(200);
      expect(upstreamUrl).toBe('https://api.openai.com/v1/images/generations');
      expect(upstreamBody).toMatchObject({ model: 'gpt-image-2', prompt: 'A minimal icon', quality: 'low', size: '1024x1024', n: 1 });
      expect(upstreamBody).not.toHaveProperty('response_format');
      expect(await res.json()).toMatchObject({ data: [{ b64_json: 'openai-image' }] });
    } finally {
      await imageServer.close();
    }
  });

  it('POST /v1/images/generations maps Gemini image generation and normalizes inline data', async () => {
    let upstreamUrl = '';
    let upstreamBody: Record<string, unknown> = {};
    const imageServer = createModelHitchServer({
      providers: defaultProviders,
      apiKeys: { gemini: 'gemini-test' },
      imageGeneration: { enabled: true, providerId: 'gemini', model: 'gemini-3.1-flash-image', size: '2048x2048' },
      imageFetch: async (input, init) => {
        upstreamUrl = String(input);
        upstreamBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'gemini-image', mimeType: 'image/png' } }] } }] }), { status: 200 });
      },
    });
    const info = await imageServer.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${info.url}/v1/images/generations`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'A precise diagram' }),
      });
      expect(res.status).toBe(200);
      expect(upstreamUrl).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent');
      expect(upstreamBody).toMatchObject({
        contents: [{ role: 'user', parts: [{ text: 'A precise diagram' }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1', imageSize: '2K' } },
      });
      expect(await res.json()).toMatchObject({ data: [{ b64_json: 'gemini-image' }] });
    } finally {
      await imageServer.close();
    }
  });

  it('GET /v1/lane-health returns [] with no failures yet', async () => {
    const res = await fetch(`${base}/v1/lane-health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('GET /v1/catalog lists built-in providers without a catalog source', async () => {
    const res = await fetch(`${base}/v1/catalog`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; name?: string; callable?: boolean }>;
      builtin: string[];
    };
    expect(body.builtin).toContain('mock');
    // Registry-only mode still populates providers so the settings UI is usable.
    expect(body.providers.some((p) => p.id === 'mock' && p.callable === true)).toBe(true);
  });

  it('config keys are wired as apiKeys at server startup (no Apply needed, F2)', async () => {
    // A provider that resolves its key from the server's apiKeys option; a bare
    // server with apiKeys set must hand that key to request-time resolution.
    const keyServer = createModelHitchServer({
      providers: [
        {
          id: 'keprov',
          name: 'Key Provider',
          defaultModel: 'k1',
          capabilities: { streaming: false, toolCalling: false, vision: false, embeddings: false },
          chat: async (_p, creds) => {
            if (!creds.apiKey) throw new Error('no apiKey passed');
            return { message: { role: 'assistant', content: `got:${creds.apiKey}` }, finishReason: 'stop' };
          },
          stream: async function* () {},
        },
      ],
      defaultProviderId: 'keprov',
      apiKeys: { keprov: 'sk-wired-at-startup' }, // the F2 fix: config.keys -> apiKeys
    });
    const info2 = await keyServer.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${info2.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'k1', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const body = (await res.json()) as { choices?: Array<{ message: { content: string } }> };
      expect(res.status).toBe(200);
      expect(body.choices?.[0]?.message.content).toBe('got:sk-wired-at-startup');
    } finally {
      await keyServer.close();
    }
  });

  it('PUT /v1/config validates and applies', async () => {
    const valid = {
      version: 1,
      policy: { trusted: [{ providerId: 'mock', models: ['mock-model'] }], fallback: [], maxProviders: 2 },
      keys: { mock: 'sk-new-secret' },
    };
    const res = await fetch(`${base}/v1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valid),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    // GET now reflects the update (masked).
    const doc = (await (await fetch(`${base}/v1/config`)).json()) as { policy: { maxProviders: number } };
    expect(doc.policy.maxProviders).toBe(2);
  });

  it('PUT /v1/config rejects invalid documents with the errors', async () => {
    const bad = { policy: { trusted: [], fallback: [] } };
    const res = await fetch(`${base}/v1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/at least one/);
  });

  it('PUT /v1/config returns 501 without a configBridge', async () => {
    const bare = createModelHitchServer({ defaultProviderId: 'mock' });
    const info = await bare.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${info.url}/v1/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(501);
    } finally {
      await bare.close();
    }
  });
});