import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_VERSION, type CloudAgentConfig } from '../src/config.js';
import { validateConfig } from '../src/config.js';
import {
  cancelCursorCloudAgent,
  createCursorCloudProvider,
  getCursorCloudAgent,
  listCursorCloudAgents,
  parseSseBlock,
  validateCursorCloudApiKey,
  CURSOR_CLOUD_API_BASE,
} from '../src/providers/cursor-cloud.js';
import { CursorCloudSessionStore } from '../src/providers/cursor-cloud-session.js';
import { CloudAgentSessionStore } from '../src/providers/cloud-agent-session-store.js';
import { ModelHitchError } from '../src/core/errors.js';
import type { ChatParams } from '../src/core/types.js';

const baseConfig: CloudAgentConfig = {
  enabled: true,
  defaultModel: 'composer-2.5',
  repos: [{ url: 'https://github.com/org/repo', startingRef: 'main' }],
  mode: 'agent',
  autoCreatePR: false,
  sessionReuse: 'per-bridge-session',
};

function sseResponse(events: Array<{ event: string; data: Record<string, unknown> }>): Response {
  const body = events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n`)
    .join('\n');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function mockCursorFetch() {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });

    if (url.endsWith('/me')) {
      return new Response(JSON.stringify({ id: 'user-1' }), { status: 200 });
    }
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({ items: [{ id: 'composer-2.5' }, { id: 'mock-run' }] }), { status: 200 });
    }
    if (method === 'GET' && url.endsWith('/agents')) {
      return new Response(JSON.stringify({ items: [{ id: 'bc-mock-1', status: 'RUNNING' }] }), { status: 200 });
    }
    if (method === 'GET' && url.endsWith('/agents/bc-mock-1')) {
      return new Response(JSON.stringify({ agent: { id: 'bc-mock-1', status: 'RUNNING' } }), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/agents/bc-mock-1/cancel')) {
      return new Response(JSON.stringify({ agent: { id: 'bc-mock-1', status: 'CANCELLED' } }), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/agents')) {
      return new Response(
        JSON.stringify({
          agent: { id: 'bc-mock-1' },
          run: { id: 'run-mock-1' },
        }),
        { status: 200 },
      );
    }
    if (method === 'POST' && url.includes('/runs') && !url.endsWith('/cancel')) {
      return new Response(JSON.stringify({ run: { id: 'run-followup-1' } }), { status: 200 });
    }
    if (url.includes('/stream')) {
      return sseResponse([
        { event: 'assistant', data: { text: 'Working ' } },
        { event: 'assistant', data: { text: 'on it.' } },
        { event: 'result', data: { status: 'FINISHED', text: 'Working on it.' } },
      ]);
    }
    if (url.includes('/runs/run-mock-1') || url.includes('/runs/run-followup-1')) {
      return new Response(JSON.stringify({ id: 'run-mock-1', status: 'FINISHED', result: 'Working on it.' }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: `unmocked ${method} ${url}` } }), {
      status: 400,
    });
  };
  return { fetchImpl, calls };
}

const baseParams: ChatParams = {
  model: 'composer-2.5',
  messages: [{ role: 'user', content: 'Fix the tests' }],
};

describe('cursor-cloud provider', () => {
  it('parseSseBlock parses assistant and result events', () => {
    const parsed = parseSseBlock('event: assistant\ndata: {"text":"hi"}\n');
    expect(parsed).toEqual({ event: 'assistant', data: '{"text":"hi"}' });
  });

  it('validates API keys via GET /v1/me', async () => {
    const { fetchImpl } = mockCursorFetch();
    await expect(validateCursorCloudApiKey('test-key', { fetchImpl })).resolves.toBeUndefined();
  });

  it('creates an agent and streams the run result', async () => {
    const { fetchImpl, calls } = mockCursorFetch();
    const provider = createCursorCloudProvider({
      config: baseConfig,
      sessionStore: new CursorCloudSessionStore(),
      fetchImpl,
    });
    const result = await provider.chat(baseParams, { apiKey: 'test-key' });
    expect(result.message.content).toBe('Working on it.');
    expect(calls.some((c) => c.method === 'POST' && c.url === `${CURSOR_CLOUD_API_BASE}/agents`)).toBe(true);
    const createBody = calls.find((c) => c.url.endsWith('/agents'))?.body as Record<string, unknown>;
    expect(createBody.autoCreatePR).toBe(false);
    expect(createBody.repos).toEqual([{ url: 'https://github.com/org/repo', startingRef: 'main' }]);
  });

  it('reuses the agent for the same session id on follow-up', async () => {
    const { fetchImpl, calls } = mockCursorFetch();
    const sessionStore = new CursorCloudSessionStore();
    const provider = createCursorCloudProvider({ config: baseConfig, sessionStore, fetchImpl });
    const params = { ...baseParams, sessionId: 'sess-a' };
    await provider.chat(params, { apiKey: 'test-key' });
    await provider.chat({ ...params, messages: [{ role: 'user', content: 'And also update the README' }] }, { apiKey: 'test-key' });
    const agentCreates = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/agents'));
    const runCreates = calls.filter((c) => c.method === 'POST' && c.url.includes('/agents/bc-mock-1/runs'));
    expect(agentCreates).toHaveLength(1);
    expect(runCreates).toHaveLength(1);
  });

  it('streams text deltas from run SSE', async () => {
    const { fetchImpl } = mockCursorFetch();
    const provider = createCursorCloudProvider({
      config: baseConfig,
      sessionStore: new CursorCloudSessionStore(),
      fetchImpl,
    });
    const chunks = [];
    for await (const chunk of provider.stream(baseParams, { apiKey: 'test-key' })) {
      chunks.push(chunk);
    }
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')).toContain('Working');
    expect(chunks.at(-1)?.type).toBe('finish');
  });

  describe('durable session reuse across a bridge restart', () => {
    it('continues the recorded agent with a cold in-memory store', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mh-cursor-durable-'));
      try {
        // Bridge run 1 records the mapping.
        const first = createCursorCloudProvider({
          config: baseConfig,
          sessionStore: new CursorCloudSessionStore(),
          durableSessionStore: new CloudAgentSessionStore(dir),
          fetchImpl: mockCursorFetch().fetchImpl,
        });
        await first.chat({ ...baseParams, sessionId: 'sess-a' }, { apiKey: 'test-key' });

        // Bridge run 2: new process, empty memory, same disk.
        const calls: Array<{ method: string; url: string }> = [];
        const base = mockCursorFetch().fetchImpl;
        const fetchImpl: typeof fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
          calls.push({ method: init?.method ?? 'GET', url });
          return base(input, init);
        };
        const restarted = createCursorCloudProvider({
          config: baseConfig,
          sessionStore: new CursorCloudSessionStore(),
          durableSessionStore: new CloudAgentSessionStore(dir),
          fetchImpl,
        });
        await restarted.chat({ ...baseParams, sessionId: 'sess-a' }, { apiKey: 'test-key' });

        const agentCreates = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/agents'));
        const runCreates = calls.filter((c) => c.method === 'POST' && c.url.includes('/agents/bc-mock-1/runs'));
        expect(agentCreates).toHaveLength(0);
        expect(runCreates).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('recovers from a stale recorded agent by re-creating one', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mh-cursor-stale-'));
      try {
        const store = new CloudAgentSessionStore(dir);
        store.set('cursor-cloud', 'sess-stale', 'bc-deleted');

        const calls: Array<{ method: string; url: string }> = [];
        const fetchImpl: typeof fetch = async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
          const method = init?.method ?? 'GET';
          calls.push({ method, url });
          if (method === 'POST' && url.endsWith('/agents/bc-deleted/runs')) {
            return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'gone' } }), {
              status: 404,
            });
          }
          if (method === 'POST' && url.endsWith('/agents')) {
            return new Response(JSON.stringify({ agent: { id: 'bc-fresh' }, run: { id: 'run-fresh' } }), {
              status: 200,
            });
          }
          if (url.includes('/stream')) {
            const payload = `event: result\ndata: ${JSON.stringify({ status: 'FINISHED', text: 'ok' })}\n\n`;
            return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
          }
          return new Response(JSON.stringify({ error: { message: `unmocked ${method} ${url}` } }), { status: 400 });
        };

        const provider = createCursorCloudProvider({
          config: baseConfig,
          sessionStore: new CursorCloudSessionStore(),
          durableSessionStore: store,
          fetchImpl,
        });
        const result = await provider.chat({ ...baseParams, sessionId: 'sess-stale' }, { apiKey: 'test-key' });

        expect(result.message.content).toBe('ok');
        // Retried as a new agent, and the stale mapping was replaced.
        expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/agents'))).toBe(true);
        expect(store.get('cursor-cloud', 'sess-stale')).toBe('bc-fresh');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('per-request reuse ignores the durable map and always creates an agent', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mh-cursor-perreq-'));
      try {
        const store = new CloudAgentSessionStore(dir);
        store.set('cursor-cloud', 'sess-p', 'bc-recorded');
        const { fetchImpl, calls } = mockCursorFetch();
        const provider = createCursorCloudProvider({
          config: { ...baseConfig, sessionReuse: 'per-request' },
          sessionStore: new CursorCloudSessionStore(),
          durableSessionStore: store,
          fetchImpl,
        });

        await provider.chat({ ...baseParams, sessionId: 'sess-p' }, { apiKey: 'test-key' });

        const runCreates = calls.filter((c) => c.method === 'POST' && c.url.includes('/agents/bc-recorded/runs'));
        expect(runCreates).toHaveLength(0);
        expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/agents'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('throws missing-api-key without credentials', async () => {
    const saved = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      const provider = createCursorCloudProvider({
        config: baseConfig,
        sessionStore: new CursorCloudSessionStore(),
        fetchImpl: mockCursorFetch().fetchImpl,
      });
      const err = await provider.chat(baseParams, {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelHitchError);
      expect((err as ModelHitchError).code).toBe('missing-api-key');
    } finally {
      if (saved) process.env.CURSOR_API_KEY = saved;
    }
  });

  it('lists, gets, and cancels agents without treating cancel as run creation', async () => {
    const { fetchImpl, calls } = mockCursorFetch();
    const listed = await listCursorCloudAgents('test-key', { fetchImpl });
    expect(listed[0]?.id).toBe('bc-mock-1');
    const agent = await getCursorCloudAgent('test-key', 'bc-mock-1', { fetchImpl });
    expect(agent.status).toBe('RUNNING');
    const cancelled = await cancelCursorCloudAgent('test-key', 'bc-mock-1', { fetchImpl });
    expect(cancelled.status).toBe('CANCELLED');
    const runCreates = calls.filter((c) => c.method === 'POST' && c.url.includes('/runs') && !c.url.endsWith('/cancel'));
    expect(runCreates).toHaveLength(0);
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/agents'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/agents/bc-mock-1/cancel'))).toBe(true);
  });

  it('config validation accepts cloudAgent and rejects autoCreatePR true', () => {
    expect(
      validateConfig({
        version: CONFIG_VERSION,
        cloudAgent: { enabled: true, repos: [{ url: 'https://github.com/org/repo' }] },
      }).errors,
    ).toEqual([]);
    expect(
      validateConfig({
        version: CONFIG_VERSION,
        cloudAgent: { enabled: true, repos: [{ url: 'https://github.com/org/repo' }], autoCreatePR: true as false },
      }).errors.join('\n'),
    ).toMatch(/autoCreatePR/);
  });
});
