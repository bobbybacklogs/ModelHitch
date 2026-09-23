import { describe, expect, it } from 'vitest';
import { UsageTracker, usageDashboardHtml, type UsageEvent } from '../src/index.js';

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    providerId: 'vercel-ai-gateway',
    model: 'deepseek-v4-flash',
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

describe('UsageTracker', () => {
  it('totals requests, tokens, cost, and latency', () => {
    const t = new UsageTracker();
    t.record(event());
    t.record(event({ inputTokens: 200, outputTokens: 100, totalTokens: 300, costUsd: 0.028, latencyMs: 800 }));
    const totals = t.totals();
    expect(totals.requests).toBe(2);
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(150);
    expect(totals.totalTokens).toBe(450);
    expect(totals.costUsd).toBeCloseTo(0.042);
    expect(totals.latencyMs).toBe(2000);
  });

  it('groups by provider, model, and wire', () => {
    const t = new UsageTracker();
    t.record(event({ providerId: 'vercel-ai-gateway', model: 'openai/gpt-5.4', wire: 'chat-completions' }));
    t.record(event({ providerId: 'openai', model: 'gpt-5.4', wire: 'messages' }));
    t.record(event({ providerId: 'openai', model: 'gpt-5.4', wire: 'responses' }));
    const s = t.snapshot();
    expect(s.totals.requests).toBe(3);
    expect(s.perProvider['vercel-ai-gateway']!.requests).toBe(1);
    expect(s.perProvider['openai']!.requests).toBe(2);
    expect(s.perModel['vercel-ai-gateway/openai/gpt-5.4']!.requests).toBe(1);
    expect(s.perModel['openai/gpt-5.4']!.requests).toBe(2);
    expect(s.perWire['messages']!.requests).toBe(1);
    expect(s.perWire['responses']!.requests).toBe(1);
  });

  it('splits observed periods without a dollar cap', () => {
    const t = new UsageTracker();
    t.record(event({ costUsd: 6, providerId: 'openai', model: 'gpt-5.4' }));
    t.record(event({ costUsd: 4, at: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(), providerId: 'mock' }));
    const s = t.snapshot();
    expect(s.periods['24h']!.totals.costUsd).toBeCloseTo(6);
    expect(s.periods['24h']!.perProvider['openai']!.requests).toBe(1);
    expect(s.periods['24h']!.perProvider['mock']).toBeUndefined();
    expect(s.periods['7d']!.totals.costUsd).toBeCloseTo(10);
    expect(s.periods['30d']!.totals.requests).toBe(2);
    expect(s.periods.all.totals.costUsd).toBeCloseTo(10);
    expect(s.periods['24h']).not.toHaveProperty('capUsd');
  });

  it('tracks failover events and resets everything', () => {
    const t = new UsageTracker();
    t.record(event());
    t.recordFailover({
      at: new Date().toISOString(),
      from: { providerId: 'vercel-ai-gateway', model: 'openai/gpt-5.4' },
      to: { providerId: 'openai', model: 'gpt-5.4' },
      error: { code: 'rate-limited', message: '429', status: 429 },
      attempt: 1,
    });
    let s = t.snapshot();
    expect(s.failovers.total).toBe(1);
    expect(s.failovers.recent[0]!.to.providerId).toBe('openai');

    t.reset();
    s = t.snapshot();
    expect(s.totals.requests).toBe(0);
    expect(s.failovers.total).toBe(0);
  });

  it('caps recent lists to the last 50 events (reversed)', () => {
    const t = new UsageTracker();
    for (let i = 0; i < 60; i++) t.record(event({ model: `m${i}` }));
    const s = t.snapshot();
    expect(s.recent).toHaveLength(50);
    expect(s.recent[0]!.model).toBe('m59'); // newest first
  });

  it('handles events with missing optional usage fields', () => {
    const t = new UsageTracker();
    t.record({ providerId: 'mock', model: 'mock-model', wire: 'chat-completions', streamed: true } as UsageEvent);
    expect(t.snapshot().totals).toMatchObject({
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    });
  });
});

describe('usageDashboardHtml', () => {
  it('returns a self-contained HTML dashboard with key sections', () => {
    const html = usageDashboardHtml();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('/v1/usage');
    expect(html).toContain('ModelHitch — usage');
    expect(html).toContain('class="rail"');
    expect(html).toContain('Last 24 hours');
    expect(html).toContain('href="/workspace"');
    expect(html).not.toContain('$12');
    expect(html).not.toContain('5 hours');
    expect(html).toContain('setInterval');
  });
});
