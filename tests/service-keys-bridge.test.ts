import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModelHitchServer,
  mockProvider,
  ModelHitchError,
  type OpenAICompatibleServer,
  type Provider,
} from '../src/index.js';
import { generateServiceKey } from '../src/core/service-keys-crypto.js';
import type { ServiceKey } from '../src/core/service-keys.js';
import { serializeConfig, validateConfig } from '../src/config.js';
import { settingsPageHtml } from '../src/settings-page.js';

/**
 * Service keys on the live bridge: the auth gate appears/disappears with the
 * config, the plan rules hold (free keys walk free lanes only), limits land
 * as 429 + Retry-After, and usage is attributed per key.
 */

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'modelhitch-keys-'));
}

/** A minted (material → config entry) pair for tests. */
function mint(overrides: Partial<ServiceKey> = {}): { key: string; entry: ServiceKey } {
  const { key, prefix, hash } = generateServiceKey();
  return {
    key,
    entry: {
      id: overrides.id ?? 'k1',
      plan: overrides.plan ?? 'product',
      createdAt: new Date().toISOString(),
      keyPrefix: prefix,
      keyHash: hash,
      ...overrides,
    },
  };
}

let server: OpenAICompatibleServer;
let base: string;

beforeAll(async () => {
  server = createModelHitchServer({ providers: [mockProvider], defaultProviderId: 'mock' });
  const info = await server.listen(0, '127.0.0.1');
  base = info.url;
});

afterAll(async () => {
  await server.close();
});

function chat(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('no service keys configured', () => {
  it('stays open: inference works unauthenticated (backward compatibility)', async () => {
    const res = await chat({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect((await res.json()).object).toBe('chat.completion');
  });
});

describe('with a product key configured', () => {
  const minted = mint({ id: 'product-pro', dailyRequests: 2 });

  beforeAll(() => {
    server.reconfigure({ serviceKeys: [minted.entry] });
  });

  it('401s a request with no key, its own OpenAI error envelope', async () => {
    const res = await chat({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string; type: string } };
    expect(body.error.code).toBe('invalid-api-key');
    expect(body.error.message).toContain('Bearer mhk_');
  });

  it('401s an unknown key', async () => {
    const res = await chat(
      { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${generateServiceKey().key}` },
    );
    expect(res.status).toBe(401);
  });

  it('admits a valid key and records usage under its serviceKeyId', async () => {
    const res = await chat(
      { model: 'mock-model', messages: [{ role: 'user', content: 'hi there' }] },
      { Authorization: `Bearer ${minted.key}` },
    );
    expect(res.status).toBe(200);
    const snap = (await (await fetch(`${base}/v1/usage`)).json()) as {
      periods: { '24h': { perServiceKey: Record<string, { requests: number }> } };
    };
    expect(snap.periods['24h'].perServiceKey['product-pro']!.requests).toBe(1);
  });

  it('blocks the request over the limit with 429 + Retry-After (rolling 24h)', async () => {
    // One slot already used above; a second consumes the limit…
    const second = await chat(
      { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${minted.key}` },
    );
    expect(second.status).toBe(200);
    // …and the third is refused with the honest-gate message.
    const third = await chat(
      { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] },
      { Authorization: `Bearer ${minted.key}` },
    );
    expect(third.status).toBe(429);
    const retryAfter = Number(third.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 3600);
    const body = (await third.json()) as { error: { message: string } };
    expect(body.error.message).toContain('"product-pro"');
    expect(body.error.message).toContain('rolling 24 hours');
  });

  it('management routes stay unauthenticated while inference is gated', async () => {
    for (const path of ['/v1/models', '/v1/usage', '/v1/config', '/healthz']) {
      const res = await fetch(`${base}${path}`);
      expect(res.ok, path).toBe(true);
    }
  });

  it('clearing the keys hot-reloads the gate open again', async () => {
    server.reconfigure({ serviceKeys: undefined });
    const res = await chat({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
  });
});

describe('free service keys force the free-only walk', () => {
  const freeMock: Provider = { ...mockProvider, id: 'freeg', name: 'Free lane', defaultModel: 'mock-free' };
  const paidMock: Provider = { ...mockProvider, id: 'payg', name: 'Paid lane', defaultModel: 'mock-paid' };
  let freeServer: OpenAICompatibleServer;
  let freeBase: string;
  const freeKey = mint({ id: 'free-starter', plan: 'free' });
  const productKey = mint({ id: 'product-paid', plan: 'product' });

  beforeAll(async () => {
    freeServer = createModelHitchServer({
      providers: [freeMock, paidMock],
      defaultProviderId: 'payg',
      serviceKeys: [freeKey.entry, productKey.entry],
    });
    const info = await freeServer.listen(0, '127.0.0.1');
    freeBase = info.url;
  });

  afterAll(async () => {
    await freeServer.close();
  });

  it('a free key on a paid-model request 404s (empty free plan, like modelhitch/free)', async () => {
    const res = await fetch(`${freeBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freeKey.key}` },
      body: JSON.stringify({ model: 'payg/mock-paid', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('no free lanes');
  });

  it('a free key on a free-model request 200s through the free lane', async () => {
    const res = await fetch(`${freeBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freeKey.key}` },
      body: JSON.stringify({ model: 'freeg/mock-free', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string; choices: Array<{ message: { content: string } }> };
    expect(body.model).toBe('mock-free');
    expect(body.choices[0]!.message.content).toContain('Mock reply: hi');
  });

  it('a free key with no model routes a paid default to free-only (404), same as the id', async () => {
    const res = await fetch(`${freeBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freeKey.key}` },
      body: JSON.stringify({ model: 'modelhitch/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(404);
  });

  it('a product key routes the normal plan (the paid default)', async () => {
    const res = await fetch(`${freeBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${productKey.key}` },
      body: JSON.stringify({ model: 'modelhitch/auto', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { model: string };
    expect(body.model).toBe('mock-paid');
  });

  it('usage attributes the free-key request to the free key and the free model', async () => {
    const snap = (await (await fetch(`${freeBase}/v1/usage`)).json()) as {
      periods: { '24h': {
        perServiceKey: Record<string, { requests: number }>;
        perModel: Record<string, { requests: number }>;
      } };
    };
    expect(snap.periods['24h'].perServiceKey['free-starter']!.requests).toBe(1);
    expect(snap.periods['24h'].perServiceKey['product-paid']!.requests).toBe(1);
    expect(snap.periods['24h'].perModel['freeg/mock-free']!.requests).toBe(1);
  });
});

describe('a failed attempt consumes its admitted slot', () => {
  const failProvider: Provider = {
    ...mockProvider,
    id: 'failg',
    name: 'Failing lane',
    defaultModel: 'mock-model',
    chat: async () => {
      throw new ModelHitchError('provider-error', 'upstream blew up', { status: 502 });
    },
  };
  let failServer: OpenAICompatibleServer;
  let failBase: string;
  const key = mint({ id: 'honest', dailyRequests: 1 });

  beforeAll(async () => {
    failServer = createModelHitchServer({ providers: [failProvider], defaultProviderId: 'failg', serviceKeys: [key.entry] });
    const info = await failServer.listen(0, '127.0.0.1');
    failBase = info.url;
  });

  afterAll(async () => {
    await failServer.close();
  });

  it('upstream failure does NOT free the slot: the retry is 429', async () => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key.key}` };
    const first = await fetch(`${failBase}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(first.status).toBeGreaterThanOrEqual(500);
    const second = await fetch(`${failBase}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(second.status).toBe(429);
  });
});

describe('the Anthropic wire denies in its own envelope', () => {
  const minted = mint({ id: 'messages-pro' });

  beforeAll(() => {
    server.reconfigure({ serviceKeys: [minted.entry] });
  });

  afterAll(() => {
    server.reconfigure({ serviceKeys: undefined });
  });

  it('401 in the Anthropic error shape, with no header at all', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('Bearer mhk_');
  });

  it('x-api-key also carries the key for Anthropic-native clients', async () => {
    const ok = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': minted.key },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(ok.status).toBe(200);
  });
});

describe('config plumbing', () => {
  it('validateConfig accepts a valid serviceKeys block and rejects a broken one', () => {
    expect(validateConfig({ version: 1, serviceKeys: [{ id: 'k', plan: 'product', dailyRequests: 10 }] }).errors).toEqual([]);
    const { errors } = validateConfig({ version: 1, serviceKeys: [{ id: 'k', plan: 'nope' }] });
    expect(errors.some((e) => e.includes('plan'))).toBe(true);
  });

  it('serialized (masked) config keeps serviceKeys — they hold hashes, not secrets', () => {
    const entry = mint({ id: 'k', dailyRequests: 5 }).entry;
    const masked = serializeConfig({ version: 1, serviceKeys: [entry], keys: { openai: 'sk-secret' } }, { maskSecrets: true }) as unknown as Record<string, unknown>;
    expect(masked.serviceKeys).toEqual([entry]);
    expect(((masked.keys as Record<string, string>).openai as string)).not.toBe('sk-secret');
  });

  it('the settings page renders the read-only service keys panel with the CLI hint', () => {
    const html = settingsPageHtml();
    expect(html).toContain('<h2>Service keys</h2>');
    expect(html).toContain('service-key-rows');
    expect(html).toContain('modelhitch key new --plan free');
    expect(html).toContain('minting &amp; rotation are CLI-only');
  });
});

describe('usage storage round-trips serviceKeyId', () => {
  it('preserves the key id across reopen and shows it in the snapshot', async () => {
    const { SqliteUsageStorage } = await import('../src/core/usage-storage.js');
    const { UsageTracker } = await import('../src/core/usage.js');
    const home = tempHome();
    try {
      const t1 = new UsageTracker(new SqliteUsageStorage(join(home, 'usage.db')));
      t1.record({
        providerId: 'mock', model: 'mock-model', wire: 'chat-completions', streamed: false,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, latencyMs: 1,
        serviceKeyId: 'honest', at: new Date().toISOString(),
      });
      t1.record({
        providerId: 'mock', model: 'mock-model', wire: 'chat-completions', streamed: false,
        inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.01, latencyMs: 2,
        at: new Date().toISOString(),
      });
      t1.close();
      const t2 = new UsageTracker(new SqliteUsageStorage(join(home, 'usage.db')));
      expect(t2.snapshot().perServiceKey['honest']!.requests).toBe(1);
      const win = t2.serviceKeyWindow('honest');
      expect(win.requests).toBe(1);
      expect(win.oldestAt).toBeDefined();
      expect(t2.serviceKeyWindow('never-used')).toEqual({ requests: 0, totalTokens: 0, costUsd: 0 });
      t2.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the built CLI can mint/list/revoke keys', () => {
  const builtCli = join(import.meta.dirname, '..', 'dist/cli.js');
  // Not relying on the artifact hard-fail (cli-help.test.ts already documents
  // it); when dist exists, the key commands must work end to end.
  const skip = !existsSync(builtCli);
  const t = skip ? it.skip : it;

  t('key new prints material once and stores only the hash', () => {
    const home = tempHome();
    try {
      const env = { ...process.env, MODELHITCH_HOME: home, MODELHITCH_PORT: '39999' };
      const run = (argv: string[]) =>
        spawnSync(process.execPath, [builtCli, ...argv], { encoding: 'utf8', env });
      const mintRes = run(['key', 'new', '--plan', 'free', '--id', 'starter-1', '--daily-requests', '100']);
      expect(mintRes.status).toBe(0);
      expect(mintRes.stdout).toMatch(/mhk_[A-Za-z0-9_-]{38}/);
      expect(mintRes.stdout).toContain('shown once');

      const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { serviceKeys: ServiceKey[] };
      expect(raw.serviceKeys).toHaveLength(1);
      expect(raw.serviceKeys[0]!.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(raw.serviceKeys[0]!.dailyRequests).toBe(100);
      expect(JSON.stringify(raw)).not.toMatch(/mhk_[A-Za-z0-9_-]{38}/); // material never on disk

      const list = run(['key', 'list']);
      expect(list.status).toBe(0);
      expect(list.stdout).toContain('starter-1');
      expect(list.stdout).toContain('free');

      const revoke = run(['key', 'revoke', 'starter-1']);
      expect(revoke.status).toBe(0);
      const revoked = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { serviceKeys: ServiceKey[] };
      expect(revoked.serviceKeys[0]!.revoked).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
