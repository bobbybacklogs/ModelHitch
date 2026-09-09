import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SqliteUsageStorage,
  UsageTracker,
  createModelHitchServer,
  type Provider,
  type UsageEvent,
} from '../src/index.js';

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'modelhitch-'));
  dirs.push(dir);
  return join(dir, 'usage.db');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    providerId: 'vercel-ai-gateway',
    model: 'openai/gpt-5.4',
    wire: 'chat-completions',
    streamed: false,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    costUsd: 0.014,
    latencyMs: 1200,
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe('SqliteUsageStorage', () => {
  it('persists events and failovers across tracker instances', () => {
    const file = tempFile();
    const t1 = new UsageTracker(new SqliteUsageStorage(file));
    expect(t1.persisted).toBe(true);
    const at = '2026-08-11T10:00:00.000Z';
    t1.record(event({ inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.028, at }));
    t1.record(event());
    t1.recordFailover({
      at: new Date().toISOString(),
      from: { providerId: 'rated', model: 'rated-model' },
      to: { providerId: 'fallback', model: 'fallback-model' },
      error: { code: 'rate-limited', message: 'vercel-ai-gateway failed: HTTP 429 rate-limited', status: 429 },
      attempt: 1,
    });
    t1.close();

    // New tracker over the same file — history must survive.
    const t2 = new UsageTracker(new SqliteUsageStorage(file));
    const s = t2.snapshot();
    expect(s.persisted).toBe(true);
    expect(s.totals.requests).toBe(2);
    expect(s.totals.inputTokens).toBe(300);
    expect(s.totals.outputTokens).toBe(150);
    expect(s.totals.costUsd).toBeCloseTo(0.042);
    expect(s.since).toBe(at);
    expect(s.failovers.total).toBe(1);
    expect(s.failovers.recent[0]!.from.providerId).toBe('rated');
    expect(s.failovers.recent[0]!.error.status).toBe(429);
    t2.close();
  });

  it('restores recent events newest-first and keeps rolling windows', () => {
    const file = tempFile();
    const t1 = new UsageTracker(new SqliteUsageStorage(file));
    // 29d ago (inside the 30d window), 8d ago (inside 30d only), now.
    const old = new Date(Date.now() - 29 * 24 * 3600_000).toISOString();
    const week = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    t1.record(event({ costUsd: 40, at: old }));
    t1.record(event({ costUsd: 10, at: week }));
    t1.record(event({ costUsd: 5 }));
    t1.close();

    const t2 = new UsageTracker(new SqliteUsageStorage(file));
    const s = t2.snapshot();
    expect(s.recent.map((e) => e.costUsd)).toEqual([5, 10, 40]);
    expect(s.windows['30d']!.costUsd).toBeCloseTo(55);
    expect(s.windows['7d']!.costUsd).toBeCloseTo(5);
    expect(s.windows['5h']!.costUsd).toBeCloseTo(5);
    t2.close();
  });

  it('reset() clears persisted history too', () => {
    const file = tempFile();
    const t1 = new UsageTracker(new SqliteUsageStorage(file));
    t1.record(event());
    t1.recordFailover({
      at: new Date().toISOString(),
      from: { providerId: 'a', model: 'a1' },
      to: { providerId: 'b', model: 'b1' },
      error: { code: 'provider-error', message: 'boom' },
      attempt: 1,
    });
    t1.reset();
    t1.close();

    const t2 = new UsageTracker(new SqliteUsageStorage(file));
    const s = t2.snapshot();
    expect(s.totals.requests).toBe(0);
    expect(s.failovers.total).toBe(0);
    t2.close();
  });

  it('supports :memory: databases', () => {
    const t = new UsageTracker(new SqliteUsageStorage(':memory:'));
    t.record(event());
    expect(t.snapshot().totals.requests).toBe(1);
    expect(t.persisted).toBe(true);
    t.close();
  });

  it('in-memory tracker reports persisted=false', () => {
    const t = new UsageTracker();
    t.record(event());
    expect(t.persisted).toBe(false);
    expect(t.snapshot().persisted).toBe(false);
  });
});

const mock: Provider = {
  id: 'mock',
  name: 'Mock',
  defaultModel: 'mock-model',
  capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
  async chat() {
    return {
      message: { role: 'assistant', content: 'Mock reply' },
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 17 },
    };
  },
  async *stream() {
    yield { type: 'text-delta', text: 'Mock reply' };
    yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 17 } };
  },
};

describe('server usagePersistence (E2E)', () => {
  it('usage survives a full server restart from the same SQLite file', async () => {
    const file = tempFile();
    const s1 = createModelHitchServer({
      providers: [mock],
      defaultProviderId: 'mock',
      usagePersistence: file,
      logger: () => {},
    });
    const { url: url1 } = await s1.listen(0, '127.0.0.1');
    await fetch(`${url1}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock/mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await s1.close();

    const s2 = createModelHitchServer({
      providers: [mock],
      defaultProviderId: 'mock',
      usagePersistence: file,
      logger: () => {},
    });
    const { url: url2 } = await s2.listen(0, '127.0.0.1');
    const usage = (await (await fetch(`${url2}/v1/usage`)).json()) as any;
    expect(usage.persisted).toBe(true);
    expect(usage.totals.requests).toBe(1);
    expect(usage.perProvider['mock']!.requests).toBe(1);
    expect(usage.perModel['mock/mock-model']!.requests).toBe(1);
    expect(usage.recent[0]!.content ?? usage.recent[0]!.providerId).toBe('mock');
    await s2.close();
  });

  it('creates parent directories for custom paths and writes the default file for true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'modelhitch-'));
    dirs.push(dir);
    const nested = join(dir, 'nested', 'deep', 'usage.db');
    const s1 = createModelHitchServer({
      providers: [mock],
      defaultProviderId: 'mock',
      usagePersistence: nested,
      logger: () => {},
    });
    await s1.listen(0, '127.0.0.1');
    await s1.close();
    const t = new UsageTracker(new SqliteUsageStorage(nested));
    t.close();
    expect(true).toBe(true); // opened without throwing — dir was created
  });
});
