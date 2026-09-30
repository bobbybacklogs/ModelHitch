import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ModelHitchError,
  applyOpenCodeByokPlan,
  describeOpenCodeByokPlan,
  openCodeByokApiKeys,
  openCodeByokModels,
  openCodeByokProviders,
  openCodeModelsForConnection,
  parseJsonc,
  readOpenCodeLocalState,
  resolveOpenCodeByokConnections,
  type ModelHitchConfig,
  type OpenCodeByokConfig,
  type OpenCodeLocalState,
} from '../src/index.js';
import {
  createOpenCodeByokProvider,
  isOpenCodeByokProviderId,
  openCodeByokBaseUrl,
  openCodeByokProviderId,
  openCodeByokSlug,
  openCodeByokWire,
  OPENCODE_BYOK_BASE_URL_PREFIX,
} from '../src/providers/opencode-byok.js';
import { detectOpenCodeWire } from '../src/providers/opencode.js';
import type { ChatParams } from '../src/core/types.js';

/**
 * OpenCode Console BYOK.
 *
 * Console gives every connected provider one gateway URL and one schema, and
 * authenticates with a Console service-account key. These tests pin the parts
 * that would silently misroute real traffic: the derived gateway URL, the
 * schema->wire mapping, the model list each lane advertises, the key fallback
 * chain, and how the connections join the rotation.
 */

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh-opencode-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function baseConfig(overrides: Partial<ModelHitchConfig> = {}): ModelHitchConfig {
  return { version: 1, ...overrides };
}

const connection = { id: 'conn_02bb39d0c001jtG67gsmQfZw83', label: 'DeepSeek', models: ['deepseek-chat'] };

// ---- ids, URLs, schema mapping --------------------------------------------

describe('Console BYOK connection identity', () => {
  it('derives the Console gateway URL from a bare connection id', () => {
    expect(openCodeByokBaseUrl('conn_abc123')).toBe(`${OPENCODE_BYOK_BASE_URL_PREFIX}/conn_abc123`);
    expect(openCodeByokBaseUrl(`${OPENCODE_BYOK_BASE_URL_PREFIX}/conn_abc123/`)).toBe(
      `${OPENCODE_BYOK_BASE_URL_PREFIX}/conn_abc123`,
    );
  });

  it('passes a full custom gateway URL through unchanged', () => {
    const url = 'https://gateway.internal/byok/deepseek';
    expect(openCodeByokBaseUrl(url)).toBe(url);
  });

  it('slugs a connection id into a routable provider id', () => {
    expect(openCodeByokSlug('conn_02bb39d0c001jtG67gsmQfZw83')).toBe('02bb39d0c001jtg67gsmqfzw83');
    expect(openCodeByokProviderId('conn_ABC-123')).toBe('opencode-byok-abc-123');
    expect(openCodeByokProviderId('', 'DeepSeek EU')).toBe('opencode-byok-deepseek-eu');
    expect(openCodeByokProviderId('conn_@@@', '')).toBe('opencode-byok-default');
    expect(isOpenCodeByokProviderId('opencode-byok-deepseek')).toBe(true);
    expect(isOpenCodeByokProviderId('opencode')).toBe(false);
  });

  it('maps each Console schema to a wire, and auto to family detection', () => {
    expect(openCodeByokWire('chat-completions')).toBe('chat-completions');
    expect(openCodeByokWire('responses')).toBe('responses');
    expect(openCodeByokWire('anthropic')).toBe('messages');
    expect(openCodeByokWire('google')).toBe('gemini');
    expect(openCodeByokWire('auto')).toBeUndefined();
    // `auto` keeps the Zen behavior: the family decides.
    expect(detectOpenCodeWire('claude-sonnet-4-6')).toBe('messages');
  });
});

// ---- the provider itself ---------------------------------------------------

function capturingFetch(status = 500): { calls: Array<{ url: string; headers: Record<string, string>; body: any }>; impl: typeof fetch } {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    let body: unknown = {};
    try {
      body = JSON.parse(String(init?.body ?? '{}'));
    } catch {
      body = {};
    }
    // Adapters may pass a plain object or a Headers instance — normalize both.
    const raw = init?.headers as unknown;
    const flat: Record<string, string> =
      raw && typeof (raw as { forEach?: unknown }).forEach === 'function'
        ? Object.fromEntries((raw as { entries(): Iterable<[string, string]> }).entries())
        : ((raw ?? {}) as Record<string, string>);
    calls.push({ url, headers: flat, body });
    return new Response('{"error":{"message":"upstream down"}}', { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, impl };
}

function params(model: string): ChatParams {
  return { model, messages: [{ role: 'user', content: 'hi' }] };
}

describe('Console BYOK provider', () => {
  it('posts each schema to its Console path with the service-account key', async () => {
    // Console reads the key from Authorization or x-goog-api-key, which is why
    // the Google schema can keep the native header.
    const cases: Array<[string, string, string]> = [
      ['chat-completions', '/chat/completions', 'Authorization'],
      ['responses', '/responses', 'Authorization'],
      ['anthropic', '/messages', 'Authorization'],
      ['google', '/models/deepseek-chat:generateContent', 'x-goog-api-key'],
    ];
    for (const [schema, path, authHeader] of cases) {
      const capture = capturingFetch();
      const provider = createOpenCodeByokProvider(
        { ...connection, schema: schema as never },
        { fetchImpl: capture.impl },
      );
      await expect(provider.chat(params('deepseek-chat'), { apiKey: 'console-key' })).rejects.toBeInstanceOf(ModelHitchError);
      expect(capture.calls[0]?.url).toBe(`${OPENCODE_BYOK_BASE_URL_PREFIX}/conn_02bb39d0c001jtG67gsmQfZw83${path}`);
      const expectedAuth = authHeader === 'Authorization' ? 'Bearer console-key' : 'console-key';
      expect(capture.calls[0]?.headers[authHeader]).toBe(expectedAuth);
      expect(capture.calls[0]?.headers['User-Agent']).toBe('ModelHitch-OpenCode/2.0');
    }
  });

  it('honors a gateway URL override verbatim', async () => {
    const capture = capturingFetch();
    const provider = createOpenCodeByokProvider(
      { id: 'conn_x', baseUrl: 'https://gateway.internal/byok', models: ['m1'] },
      { fetchImpl: capture.impl },
    );
    await expect(provider.chat(params('m1'), { apiKey: 'k' })).rejects.toBeInstanceOf(ModelHitchError);
    expect(capture.calls[0]?.url).toBe('https://gateway.internal/byok/chat/completions');
  });

  it('advertises exactly the models the connection enables, with no network call', async () => {
    const provider = createOpenCodeByokProvider(
      { ...connection, models: ['deepseek-chat', 'deepseek-reasoner'] },
      {
        fetchImpl: async () => {
          throw new Error('listModels must not hit the network for a BYOK connection');
        },
      },
    );
    const listed = await provider.listModels?.({});
    expect(listed?.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
    expect(provider.defaultModel).toBe('deepseek-chat');
  });

  it('refuses to call without any Console key', async () => {
    const previous = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      const provider = createOpenCodeByokProvider(connection, { fetchImpl: capturingFetch().impl });
      await expect(provider.chat(params('deepseek-chat'), {})).rejects.toMatchObject({ code: 'missing-api-key' });
    } finally {
      if (previous !== undefined) process.env.OPENCODE_API_KEY = previous;
    }
  });
});

// ---- rotation / pin plan ---------------------------------------------------

describe('Console BYOK rotation and pin plan', () => {
  const config = baseConfig({
    defaultProviderId: 'vercel-ai-gateway',
    defaultModel: 'openai/gpt-5.4',
    policy: {
      trusted: [{ providerId: 'vercel-ai-gateway', models: ['openai/gpt-5.4'] }],
      fallback: [{ providerId: 'openai', models: ['gpt-5.4'] }],
    },
    opencodeByok: {
      enabled: true,
      mode: 'rotation',
      connections: [
        { id: 'conn_deepseek', label: 'deepseek', models: ['deepseek-chat'] },
        { id: 'conn_claude', label: 'claude', models: ['claude-sonnet-4-6', 'claude-haiku-4-5'] },
      ],
    },
  });

  it('rotates across every connection and model, ahead of the configured policy', () => {
    const plan = applyOpenCodeByokPlan({ config, policy: config.policy, defaultProviderId: config.defaultProviderId });
    expect(plan.defaultProviderId).toBe('opencode-byok-deepseek');
    expect(plan.defaultModel).toBe('deepseek-chat');
    expect(plan.lanes.map((lane) => `${lane.providerId}/${lane.model}`)).toEqual([
      'opencode-byok-deepseek/deepseek-chat',
      'opencode-byok-claude/claude-sonnet-4-6',
      'opencode-byok-claude/claude-haiku-4-5',
    ]);
    // BYOK first, the configured lanes immediately behind it as the safety net.
    expect(plan.policy?.trusted).toEqual([
      { providerId: 'opencode-byok-deepseek', models: ['deepseek-chat'] },
      { providerId: 'opencode-byok-claude', models: ['claude-sonnet-4-6', 'claude-haiku-4-5'] },
      { providerId: 'vercel-ai-gateway', models: ['openai/gpt-5.4'] },
    ]);
    expect(plan.policy?.fallback).toEqual([{ providerId: 'openai', models: ['gpt-5.4'] }]);
    expect(describeOpenCodeByokPlan(plan, config)).toContain('OpenCode BYOK rotation: 3 lanes');
  });

  it('pins one connection and its model, keeping the rest reachable', () => {
    const pinned = baseConfig({
      ...config,
      opencodeByok: { ...config.opencodeByok!, mode: 'pinned', pinnedConnectionId: 'conn_claude', pinnedModel: 'claude-haiku-4-5' },
    });
    const plan = applyOpenCodeByokPlan({ config: pinned, policy: pinned.policy });
    expect(plan.defaultProviderId).toBe('opencode-byok-claude');
    expect(plan.defaultModel).toBe('claude-haiku-4-5');
    // The pinned connection leads; every other lane (its own models included)
    // is still in the plan.
    expect(plan.policy?.trusted[0]).toEqual({
      providerId: 'opencode-byok-claude',
      models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    });
    expect(plan.policy?.trusted.map((entry) => entry.providerId)).toEqual([
      'opencode-byok-claude',
      'opencode-byok-deepseek',
      'vercel-ai-gateway',
    ]);
  });

  it('synthesizes a policy when the document has none', () => {
    const bare = baseConfig({
      opencodeByok: { enabled: true, connections: [{ id: 'conn_x', models: ['m'] }] },
    });
    const plan = applyOpenCodeByokPlan({ config: bare, policy: undefined });
    expect(plan.policy).toEqual({ trusted: [{ providerId: 'opencode-byok-x', models: ['m'] }], fallback: [] });
    expect(plan.defaultProviderId).toBe('opencode-byok-x');
  });

  it('leaves routing untouched when the block is off or empty', () => {
    const off = baseConfig({ policy: config.policy, opencodeByok: { enabled: false, connections: [{ id: 'conn_x', models: ['m'] }] } });
    const plan = applyOpenCodeByokPlan({ config: off, policy: off.policy, defaultProviderId: 'vercel-ai-gateway' });
    expect(plan.lanes).toEqual([]);
    expect(plan.policy).toBe(off.policy);
    expect(plan.defaultProviderId).toBe('vercel-ai-gateway');
    expect(describeOpenCodeByokPlan(plan, off)).toBeUndefined();

    const empty = baseConfig({ opencodeByok: { enabled: true, connections: [] } });
    expect(applyOpenCodeByokPlan({ config: empty }).lanes).toEqual([]);
  });

  it('skips disabled connections', () => {
    const config2 = baseConfig({
      opencodeByok: {
        enabled: true,
        connections: [
          { id: 'a', models: ['m1'] },
          { id: 'b', models: ['m2'], enabled: false },
        ],
      },
    });
    expect(resolveOpenCodeByokConnections(config2).map((c) => c.providerId)).toEqual(['opencode-byok-a']);
    expect(openCodeByokProviders(config2).map((p) => p.id)).toEqual(['opencode-byok-a']);
  });
});

// ---- key resolution --------------------------------------------------------

describe('Console BYOK credentials', () => {
  const byok: OpenCodeByokConfig = { enabled: true, connections: [{ id: 'conn_deepseek', models: ['deepseek-chat'] }] };

  it('reuses the OpenCode key from settings', () => {
    const config = baseConfig({ opencodeByok: byok, keys: { opencode: 'console-key' } });
    expect(openCodeByokApiKeys(config)).toEqual({ 'opencode-byok-deepseek': 'console-key' });
  });

  it('prefers a dedicated BYOK key, then a per-connection key, then the env', () => {
    const previous = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'env-key';
    try {
      expect(openCodeByokApiKeys(baseConfig({ opencodeByok: byok }))).toEqual({ 'opencode-byok-deepseek': 'env-key' });
      expect(
        openCodeByokApiKeys(baseConfig({ opencodeByok: byok, keys: { 'opencode-go': 'go-key' } })),
      ).toEqual({ 'opencode-byok-deepseek': 'go-key' });
      expect(
        openCodeByokApiKeys(baseConfig({ opencodeByok: byok, keys: { opencode: 'zen', 'opencode-byok': 'byok-key' } })),
      ).toEqual({ 'opencode-byok-deepseek': 'byok-key' });
      expect(
        openCodeByokApiKeys(baseConfig({ opencodeByok: byok, keys: { 'opencode-byok': 'byok-key', 'opencode-byok-deepseek': 'per-conn' } })),
      ).toEqual({ 'opencode-byok-deepseek': 'per-conn' });
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previous;
    }
  });
});

// ---- local OpenCode state --------------------------------------------------

describe('OpenCode local state import', () => {
  it('matches a connection to the provider name it carries', () => {
    const state: OpenCodeLocalState = {
      found: true,
      sources: ['opencode.db'],
      warnings: [],
      providers: [{ providerId: 'deepseek', models: ['deepseek-chat', 'deepseek-reasoner'] }],
    };
    expect(openCodeModelsForConnection({ id: 'conn_deepseek', label: 'DeepSeek' }, state)).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
    expect(openCodeModelsForConnection({ id: 'conn_other' }, state)).toEqual([]);
    expect(openCodeModelsForConnection({ id: 'conn_x', label: 'deepseek' }, state)).toEqual([
      'deepseek-chat',
      'deepseek-reasoner',
    ]);
  });

  it('seeds empty model lists only when syncFromOpenCode is on', () => {
    const state: OpenCodeLocalState = {
      found: true,
      sources: [],
      warnings: [],
      providers: [{ providerId: 'deepseek', models: [] }, { providerId: 'claude', models: [] }],
    };
    state.providers = [{ providerId: 'deepseek', models: ['deepseek-chat'] }];
    const syncing = baseConfig({
      opencodeByok: { enabled: true, syncFromOpenCode: true, connections: [{ id: 'conn_deepseek', label: 'deepseek' }] },
    });
    const [resolved] = resolveOpenCodeByokConnections(syncing, state);
    expect(resolved?.models).toEqual(['deepseek-chat']);
    expect(resolved?.modelsFromOpenCode).toBe(true);

    const notSyncing = baseConfig({
      opencodeByok: { enabled: true, syncFromOpenCode: false, connections: [{ id: 'conn_deepseek', label: 'deepseek' }] },
    });
    expect(resolveOpenCodeByokConnections(notSyncing, state)[0]?.models).toEqual([]);

    // Explicit models always win over discovery.
    const explicit = baseConfig({
      opencodeByok: {
        enabled: true,
        syncFromOpenCode: true,
        connections: [{ id: 'conn_deepseek', label: 'deepseek', models: ['pinned-model'] }],
      },
    });
    expect(openCodeByokModels(explicit.opencodeByok!.connections[0]!, state)).toEqual({
      models: ['pinned-model'],
      fromOpenCode: false,
    });
  });

  it('strips comments from a jsonc OpenCode config', () => {
    expect(parseJsonc('{\n // comment\n "model": "deepseek/deepseek-chat", /* block */ "a": "http://x//y"\n}')).toEqual({
      model: 'deepseek/deepseek-chat',
      a: 'http://x//y',
    });
  });

  it('reads auth.json, the selected model, and per-provider model maps', () => {
    const dataDir = tempDir();
    const configDir = tempDir();
    mkdirSync(join(dataDir), { recursive: true });
    writeFileSync(
      join(dataDir, 'auth.json'),
      JSON.stringify({ deepseek: { type: 'api', key: 'sk-x' }, 'opencode-go': { type: 'api', key: 'sk-y' } }),
      'utf8',
    );
    writeFileSync(
      join(configDir, 'opencode.jsonc'),
      `{
        // the model this user actually runs
        "model": "deepseek/deepseek-chat",
        "provider": {
          "openrouter": { "models": { "auto": {}, "meta-llama/llama-3.1-8b-instruct:free": {} } }
        }
      }`,
      'utf8',
    );

    const state = readOpenCodeLocalState({ home: tmpdir(), dataDir, configDir });
    expect(state.found).toBe(true);
    expect(state.selected).toEqual({ providerId: 'deepseek', modelId: 'deepseek-chat' });
    const deepseek = state.providers.find((p) => p.providerId === 'deepseek');
    expect(deepseek?.models).toContain('deepseek-chat');
    expect(deepseek?.credentialType).toBe('api');
    expect(state.providers.find((p) => p.providerId === 'openrouter')?.models).toEqual([
      'auto',
      'meta-llama/llama-3.1-8b-instruct:free',
    ]);
    expect(state.warnings).toEqual([]);
  });

  it('reports found=false instead of throwing when there is no OpenCode install', () => {
    const state = readOpenCodeLocalState({
      home: tempDir(),
      dataDir: join(tempDir(), 'nope'),
      configDir: join(tempDir(), 'also-nope'),
    });
    expect(state).toMatchObject({ found: false, providers: [] });
  });
});
